// Agent Loop 核心引擎 — 对应 吃透 AI Agent 开发 课程第二章
// 设计思路：while(true) { think → act → observe }
// 遵循"从内到外"原则：先搭心跳（Agent Loop），再接手脚（Tool System）
//
// 课程对照：
// - Agent Loop 的 think→act→observe 循环 (第二章)
// - 三根保险丝：死循环检测、Token 预算、截断恢复 (第二章)
// - 七种退出路径 (第二章)
// - "Say While Do"：工具块一完成就执行，不等整条消息 (第二章/第五章)
// - 错误信息为 LLM 设计 (第三章)

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  Tool as AnthropicTool,
  RawMessageStreamEvent,
  ToolUseBlock,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

// ──────────────────────────────────────────
// 配置
// ──────────────────────────────────────────

export interface AgentLoopConfig {
  /** Anthropic API Key (默认取 ANTHROPIC_API_KEY 环境变量) */
  apiKey?: string;
  /** Anthropic API Base URL (默认取 ANTHROPIC_BASE_URL 环境变量，不设则用官方) */
  baseURL?: string;
  /** 模型名称 */
  model: string;
  /** 单次输出最大 Token */
  maxTokens: number;
  /** 最大轮次 */
  maxTurns: number;
  /** Token 预算（总输出 token 上限） */
  tokenBudget: number;
  /** 死循环检测：相同指纹多少次后报警 */
  loopWarnThreshold: number;
  /** 死循环检测：相同指纹多少次后熔断 */
  loopBreakThreshold: number;
}

export const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  model: 'claude-sonnet-4-6',
  maxTokens: 8192,
  maxTurns: 30,
  tokenBudget: 50_000,
  loopWarnThreshold: 5,
  loopBreakThreshold: 10,
};

// ──────────────────────────────────────────
// 退出路径 — 对应课程 七种退出路径
// ──────────────────────────────────────────

export type ExitReason =
  | { type: 'completed'; message: string }           // 正常完成 (end_turn)
  | { type: 'max_turns'; message: string; turn: number }            // 超轮次
  | { type: 'aborted_streaming'; message: string }     // 用户中断流式输出
  | { type: 'aborted_tools'; message: string }         // 用户中断工具执行
  | { type: 'loop_detected'; message: string; tool: string }        // 死循环熔断
  | { type: 'token_budget_exceeded'; message: string; used: number } // Token 预算耗尽
  | { type: 'truncation_give_up'; message: string };    // 截断恢复失败

// ──────────────────────────────────────────
// Agent Loop 结果
// ──────────────────────────────────────────

export interface AgentLoopResult {
  messages: MessageParam[];
  exitReason: ExitReason;
  usage: {
    turnCount: number;
    totalOutputTokens: number;
    totalInputTokens: number;
  };
}

// ──────────────────────────────────────────
// 保险丝状态 — 对应课程 三根保险丝
// ──────────────────────────────────────────

interface FuseState {
  // 保险丝 1：工具死循环检测
  loopHistory: Map<string, { count: number; lastResult: string }>;
  warnInjected: boolean;

  // 保险丝 2：Token 预算
  totalOutputTokens: number;
  lowStreak: number;
  nudgeInjected: boolean;

  // 保险丝 3：截断恢复
  recoveryCount: number;

  // 统计
  turnCount: number;
  totalInputTokens: number;
}

function createFuseState(): FuseState {
  return {
    loopHistory: new Map(),
    warnInjected: false,
    totalOutputTokens: 0,
    lowStreak: 0,
    nudgeInjected: false,
    recoveryCount: 0,
    turnCount: 0,
    totalInputTokens: 0,
  };
}

// ──────────────────────────────────────────
// 工具指纹 — 用于死循环检测
// ──────────────────────────────────────────

import { createHash } from 'node:crypto';

/**
 * 将工具名 + 稳定序列化的参数 → SHA256 指纹
 * 对应课程：给每次调用"打指纹"
 */
function toolFingerprint(name: string, params: unknown): string {
  // 稳定序列化：先排 key，保证相同对象产出相同哈希
  const sorted = JSON.stringify(params, Object.keys((params ?? {}) as Record<string, unknown>).sort());
  return createHash('sha256').update(name + sorted).digest('hex').slice(0, 12);
}

// ──────────────────────────────────────────
// 保险丝 1：工具死循环检测
// 对应课程：四种检测器 + 三级响应
// ──────────────────────────────────────────

type LoopStatus = 'ok' | 'warn' | 'break';

function checkLoop(
  state: FuseState,
  toolName: string,
  params: unknown,
  result: string,
  config: AgentLoopConfig,
): LoopStatus {
  // 只检测写操作 / 有副作用的工具
  const writeTools = new Set(['edit_file', 'write_file', 'bash', 'execute']);
  if (!writeTools.has(toolName)) return 'ok';

  const fp = toolFingerprint(toolName, params);
  const entry = state.loopHistory.get(fp) ?? { count: 0, lastResult: '' };

  // 关键：同样的调用 + 同样的结果 = 无进展
  if (entry.lastResult === result) {
    entry.count++;
  } else {
    entry.count = 1; // 结果变了，重新计数
  }
  entry.lastResult = result;
  state.loopHistory.set(fp, entry);

  if (entry.count >= config.loopBreakThreshold) return 'break';
  if (entry.count >= config.loopWarnThreshold) return 'warn';
  return 'ok';
}

// ──────────────────────────────────────────
// 保险丝 2：Token 预算控制
// 对应课程：90% nudge + 递减回报检测
// ──────────────────────────────────────────

type BudgetStatus = 'ok' | 'nudge' | 'stop';

function checkBudget(state: FuseState, tokens: number, config: AgentLoopConfig): BudgetStatus {
  state.totalOutputTokens += tokens;

  // 递减回报检测：最近两次增量 < 500 token → 停止
  if (state.totalOutputTokens > 5000) {
    if (tokens < 500) {
      state.lowStreak++;
    } else {
      state.lowStreak = 0;
    }
    if (state.lowStreak >= 2) return 'stop';
  }

  // 90% 预算 → 注入 nudge 消息
  if (state.totalOutputTokens >= config.tokenBudget * 0.9 && !state.nudgeInjected) {
    return 'nudge';
  }

  // 超预算 → 强制停止
  if (state.totalOutputTokens >= config.tokenBudget) return 'stop';

  return 'ok';
}

// ──────────────────────────────────────────
// 保险丝 3：输出截断恢复
// 对应课程：三步递进恢复
// ──────────────────────────────────────────

type RecoveryAction = 'retry' | 'give_up';

const MAX_RECOVERY = 3;

function handleTruncation(state: FuseState, messages: MessageParam[]): RecoveryAction {
  state.recoveryCount++;
  if (state.recoveryCount > MAX_RECOVERY) return 'give_up';

  // 第一次温和，后续更强硬
  const msg = state.recoveryCount === 1
    ? '输出被截断。直接从断点继续——不要道歉，不要回顾你在做什么。把剩余工作拆成更小的块。'
    : '再次被截断。请大幅精简输出，只列关键结论。继续工作——不要总结前面做过的事。';

  messages.push({
    role: 'user',
    content: `[TRUNCATION_RECOVERY ${state.recoveryCount}/${MAX_RECOVERY}] ${msg}`,
  } as MessageParam);

  return 'retry';
}

// ──────────────────────────────────────────
// 流式消息解析
// 对应课程：SSE 流式 + JSON 碎片攒池 + "边说边执行"
// ──────────────────────────────────────────

interface StreamAccumulator {
  textParts: string[];
  currentToolBlock: ToolUseBlock | null;
  currentToolJsonParts: string[];
  toolCalls: ToolUseBlock[];
}

function createAccumulator(): StreamAccumulator {
  return { textParts: [], currentToolBlock: null, currentToolJsonParts: [], toolCalls: [] };
}

/**
 * 处理单条流式事件，累积结果
 * 返回 true 表示消息还在继续，false 表示消息结束
 */
function processStreamEvent(
  event: RawMessageStreamEvent,
  acc: StreamAccumulator,
): 'in_progress' | 'block_complete' | 'message_complete' {
  switch (event.type) {
    case 'content_block_start': {
      if (event.content_block.type === 'tool_use') {
        acc.currentToolBlock = event.content_block as ToolUseBlock;
        acc.currentToolJsonParts = [];
      }
      return 'in_progress';
    }

    case 'content_block_delta': {
      if (event.delta.type === 'text_delta') {
        acc.textParts.push(event.delta.text);
      }
      if (event.delta.type === 'input_json_delta') {
        acc.currentToolJsonParts.push(event.delta.partial_json);
      }
      return 'in_progress';
    }

    case 'content_block_stop': {
      if (acc.currentToolBlock) {
        // 攒完碎片，拼完整的 JSON 并解析
        const fullJson = acc.currentToolJsonParts.join('');
        try {
          const parsed = JSON.parse(fullJson);
          acc.currentToolBlock.input = parsed;
        } catch {
          // JSON 碎片不完整（极少发生），保留空对象
          acc.currentToolBlock.input = {};
        }
        acc.toolCalls.push(acc.currentToolBlock);
        acc.currentToolBlock = null;
        acc.currentToolJsonParts = [];
        return 'block_complete';
      }
      return 'in_progress';
    }

    case 'message_delta': {
      // 消息增量：包含 stop_reason 和 usage
      return 'in_progress';
    }

    case 'message_stop': {
      return 'message_complete';
    }

    default:
      return 'in_progress';
  }
}

// ──────────────────────────────────────────
// Agent Loop 主循环
// 对应课程：while(true) { think → act → observe }
// ──────────────────────────────────────────

/**
 * 运行 Agent Loop 直到退出条件触发
 *
 * @param systemPrompt - Agent 的 system prompt
 * @param messages - 消息历史（调用者负责初始化第一条 user message）
 * @param tools - Anthropic Tool 定义列表
 * @param executeTool - 工具执行回调：(name, params) => result string
 * @param config - Loop 配置
 * @param signal - 可选的 AbortSignal（支持用户中断）
 */
export async function runAgentLoop(
  systemPrompt: string,
  messages: MessageParam[],
  tools: AnthropicTool[],
  executeTool: (name: string, params: Record<string, unknown>) => Promise<string>,
  config: AgentLoopConfig = DEFAULT_LOOP_CONFIG,
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  const apiKey = config.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return {
      messages,
      exitReason: { type: 'aborted_tools', message: '未设置 ANTHROPIC_API_KEY。请设置环境变量或在配置中传入 apiKey。' },
      usage: { turnCount: 0, totalOutputTokens: 0, totalInputTokens: 0 },
    };
  }
  const baseURL = config.baseURL ?? process.env['ANTHROPIC_BASE_URL'];
  // 自定义 fetch：移除 User-Agent 头避免被某些代理的 Cloudflare WAF 拦截
  const fetchWithoutUA: typeof globalThis.fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('user-agent');
    return globalThis.fetch(url, { ...init, headers });
  };
  const client = new Anthropic(baseURL
    ? { apiKey, baseURL, fetch: fetchWithoutUA }
    : { apiKey, fetch: fetchWithoutUA });
  const state = createFuseState();

  while (true) {
    state.turnCount++;

    // ── 退出路径 2: max_turns ──
    if (state.turnCount > config.maxTurns) {
      return {
        messages,
        exitReason: { type: 'max_turns', message: `超过最大轮次 ${config.maxTurns}`, turn: state.turnCount - 1 },
        usage: { turnCount: state.turnCount - 1, totalOutputTokens: state.totalOutputTokens, totalInputTokens: state.totalInputTokens },
      };
    }

    // ── 预检：blocking_limit（上下文快满了提前拦截）─
    // 粗略估算：system prompt + messages 的近似 token 数
    const estimatedContextTokens = estimateTokenCount(systemPrompt) + messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0) + tools.reduce((sum, t) => sum + estimateTokenCount(JSON.stringify(t)), 0);
    // 200K 窗口保留 3000 token 缓冲区
    if (estimatedContextTokens > 197_000) {
      return {
        messages,
        exitReason: { type: 'aborted_streaming', message: '上下文窗口接近上限，提前终止' },
        usage: { turnCount: state.turnCount, totalOutputTokens: state.totalOutputTokens, totalInputTokens: state.totalInputTokens },
      };
    }

    // ── Think: 调 LLM ──
    let responseText = '';
    const toolCalls: ToolUseBlock[] = [];
    const acc = createAccumulator();

    try {
      const stream = await client.messages.create(
        {
          model: config.model,
          max_tokens: config.maxTokens,
          system: [{ type: 'text', text: systemPrompt }],
          messages,
          tools,
          stream: true,
        },
        { signal },
      );

      // 流式处理：攒碎片 → 在 content_block_stop 时判断工具是否就绪
      for await (const event of stream) {
        const status = processStreamEvent(event, acc);
        if (status === 'block_complete' && acc.toolCalls.length > 0) {
          // "Say While Do" + 并发安全判断：Read 类工具立即执行
          // 注意：此处只收集完整的 tool_use block，执行在流结束后统一开始
          // 课程中 Claude Code 会"边说边执行"（工具块一完成就执行），
          // Phase 1 先简化：流结束后统一执行
        }
      }

      responseText = acc.textParts.join('');
      toolCalls.push(...acc.toolCalls);

      // ── 保险丝 3：截断检测 ──
      // 检查最后一个 message_delta 是否包含 stop_reason = 'max_tokens'
      // 如果模型输出被截断，尝试恢复
      // 注意：这里简化判断，更精确的做法是读取 message_delta 的 stop_reason
      // 但由于流式 API 的 message_delta 可能有延迟，我们用 response 长度做近似判断
      if (responseText.length === 0 && toolCalls.length === 0) {
        // 没有输出 → 可能是截断或错误
        if (handleTruncation(state, messages) === 'give_up') {
          return {
            messages,
            exitReason: { type: 'truncation_give_up', message: '连续 3 次截断恢复失败' },
            usage: { turnCount: state.turnCount, totalOutputTokens: state.totalOutputTokens, totalInputTokens: state.totalInputTokens },
          };
        }
        continue; // 带着恢复指令重试
      }

    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          messages,
          exitReason: { type: 'aborted_streaming', message: '用户中断流式输出' },
          usage: { turnCount: state.turnCount, totalOutputTokens: state.totalOutputTokens, totalInputTokens: state.totalInputTokens },
        };
      }

      // 致命错误（认证/网络不通等）→ 直接失败，不重试
      const errorMsg = formatLLMError(err);
      const isFatal = isFatalAPIError(err);
      if (isFatal) {
        return {
          messages,
          exitReason: { type: 'aborted_tools', message: `API 调用失败：${errorMsg}` },
          usage: { turnCount: state.turnCount, totalOutputTokens: state.totalOutputTokens, totalInputTokens: state.totalInputTokens },
        };
      }

      // 可重试错误 → 构造 LLM-friendly 错误消息后继续
      messages.push({ role: 'assistant', content: responseText || '(模型响应被中断)' } as MessageParam);
      messages.push({
        role: 'user',
        content: `[TOOL_ERROR] 调用 API 时出错：${errorMsg}\n请重试或换个方式。`,
      } as MessageParam);
      continue;
    }

    // ── Act: 执行工具调用 ──
    if (toolCalls.length === 0) {
      // 没有工具调用 → 模型认为任务完成了 (end_turn)
      messages.push({ role: 'assistant', content: responseText } as MessageParam);
      return {
        messages,
        exitReason: { type: 'completed', message: responseText },
        usage: { turnCount: state.turnCount, totalOutputTokens: state.totalOutputTokens, totalInputTokens: state.totalInputTokens },
      };
    }

    // 有工具调用 → 追加 assistant 消息
    const assistantContent: Array<TextBlock | ToolUseBlock> = [];
    if (responseText) {
      assistantContent.push({ type: 'text', text: responseText, citations: null });
    }
    assistantContent.push(...toolCalls.map(tc => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    })));
    messages.push({ role: 'assistant', content: assistantContent } as unknown as MessageParam);

    // ── Observe: 执行工具并处理结果 ──
    for (const toolCall of toolCalls) {
      const params = toolCall.input as Record<string, unknown>;

      let result: string;
      try {
        result = await executeTool(toolCall.name, params);
      } catch (err: unknown) {
        result = formatLLMError(err);
      }

      // ── 保险丝 1：死循环检测 ──
      const loopStatus = checkLoop(state, toolCall.name, params, result, config);
      if (loopStatus === 'break') {
        // 熔断：返回已执行的结果，但标记停止
        messages.push({
          role: 'user',
          content: `[TOOL_RESULT] ${toolCall.name} 返回：${truncateResult(result)}`,
        } as MessageParam);
        return {
          messages,
          exitReason: { type: 'loop_detected', message: `工具 ${toolCall.name} 重复 ${config.loopBreakThreshold} 次且结果相同`, tool: toolCall.name },
          usage: { turnCount: state.turnCount, totalOutputTokens: state.totalOutputTokens, totalInputTokens: state.totalInputTokens },
        };
      }

      if (loopStatus === 'warn' && !state.warnInjected) {
        // 警告：注入干预消息让模型换策略
        messages.push({
          role: 'user',
          content: `[TOOL_RESULT] ${toolCall.name} 返回：${truncateResult(result)}`,
        } as MessageParam);
        messages.push({
          role: 'user',
          content: '[LOOP_WARNING] 你正在反复用相同方式操作且没有进展。请换一种方式完成任务，比如换个命令或思路。',
        } as MessageParam);
        state.warnInjected = true;
        break; // 跳出工具循环，回到 Think 阶段
      }

      // 正常结果 → 追加到消息
      messages.push({
        role: 'user',
        content: `[TOOL_RESULT] ${toolCall.name} 返回：${truncateResult(result)}`,
      } as MessageParam);
    }

    // ── 保险丝 2：Token 预算 ──
    // 估算本轮输出 token（粗略：4 chars ≈ 1 token）
    const estimatedOutputTokens = Math.ceil(responseText.length / 4) + toolCalls.reduce((sum, tc) => sum + estimateTokenCount(JSON.stringify(tc.input)), 0);
    const budgetStatus = checkBudget(state, estimatedOutputTokens, config);

    if (budgetStatus === 'stop') {
      return {
        messages,
        exitReason: { type: 'token_budget_exceeded', message: `Token 预算 ${config.tokenBudget} 已耗尽或递减回报`, used: state.totalOutputTokens },
        usage: { turnCount: state.turnCount, totalOutputTokens: state.totalOutputTokens, totalInputTokens: state.totalInputTokens },
      };
    }

    if (budgetStatus === 'nudge') {
      messages.push({
        role: 'user',
        content: `[BUDGET_NUDGE] Token 预算已用约 ${Math.round(state.totalOutputTokens / config.tokenBudget * 100)}%。请精简输出，给关键结论。继续工作——不要总结前面做过的事。`,
      } as MessageParam);
      state.nudgeInjected = true;
    }

    // 继续下一轮循环 (think)
    continue;
  }
}

// ──────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────

/** 截断过长的工具结果（默认 5000 字符），避免撑爆上下文 */
function truncateResult(result: string, maxLen = 5000): string {
  if (result.length <= maxLen) return result;
  return `${result.slice(0, maxLen)}\n\n...（结果已截断，共 ${result.length} 字符，仅显示前 ${maxLen} 字符）`;
}

/** Token 估算：4 字符 ≈ 1 token */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 估算一条消息的 token 数 */
function estimateMessageTokens(msg: MessageParam): number {
  if (typeof msg.content === 'string') {
    return estimateTokenCount(msg.content);
  }
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, block) => {
      if (block.type === 'text') return sum + estimateTokenCount(block.text);
      if (block.type === 'tool_use') return sum + estimateTokenCount(JSON.stringify(block.input));
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') return sum + estimateTokenCount(block.content);
        return sum;
      }
      return sum;
    }, 0);
  }
  return 0;
}

/** 判断是否为致命 API 错误（不应重试） */
function isFatalAPIError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // 401: 认证失败 → 致命
    // 403: 权限不足 → 致命
    // 404: 模型不存在 → 致命
    // 400: 请求格式错误（非截断场景）→ 致命
    if ([401, 403, 404].includes(err.status)) return true;
    if (err.status === 400) {
      const msg = err.message.toLowerCase();
      // 某些 400 是截断导致的，可重试
      if (msg.includes('prompt too long') || msg.includes('context length')) return false;
      return true;
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // 认证/网络连接问题
    if (msg.includes('auth') || msg.includes('api key') || msg.includes('apikey')) return true;
    if (msg.includes('could not resolve authentication')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('enotfound')) return true;
  }
  return false;
}

/** 构造 LLM-friendly 错误信息 — 对应课程：错误信息是给模型看的，不是给人看的 */
function formatLLMError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    // Anthropic API 错误 — 给出可操作的信息
    if (err.status === 400) return '请求参数有误，请检查输入格式。';
    if (err.status === 401) return 'API Key 无效，请检查认证信息。';
    if (err.status === 429) return '请求频率过高，请稍后重试。';
    if (err.status === 500) return '模型服务暂时不可用，请稍后重试。';
    return `API 错误 (${err.status}): ${err.message}`;
  }
  if (err instanceof Error) {
    // 一般错误 — 提炼有用信息
    const msg = err.message;
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return '请求超时，请重试。';
    if (msg.includes('ECONNREFUSED')) return '连接被拒绝，请检查网络。';
    if (msg.includes('ECONNRESET')) return '连接被重置，请重试。';
    return msg;
  }
  return '未知错误，请重试。';
}
