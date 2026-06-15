// 工具服务 — 对应技术架构 2.4 节
// 职责：封装飞书 Open API，提供统一工具接口给 Agent 调用
//
// 课程对照：7 步工具执行管线 (第三章)
// 1. 参数格式验证 (Zod)
// 2. 业务逻辑校验
// 3. 输入补全 + 标准化
// 4. 前置 Hook (预留)
// 5. 权限检查 (Allow/Deny/Ask)
// 6. 执行 + 结果截断
// 7. 后置 Hook (预留)
//
// 踩坑提醒：飞书 API 有频率限制（群消息 5QPS/群，文档写入 10QPS/租户），
// 工具层需要内置 rate limiter 和重试机制，否则高峰期容易触发 429。

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ──────────────────────────────────────────
// 参数 Schema 定义 - 使用 Zod
// 课程对照：第一步 - 参数格式验证
// ──────────────────────────────────────────

/** 工具参数 Schema — 用 Zod 定义，自动做类型安全和格式校验 */
export interface ToolParameterSchema {
  /** Zod schema 描述 */
  schema: z.ZodType<unknown>;
  /** 参数描述（给 LLM 看） */
  description: string;
  /** 是否必填 */
  required: boolean;
}

// ──────────────────────────────────────────
// 风险等级和权限
// ──────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high';

/** 权限规则 — 对应课程 Allow/Deny/Ask 三层 */
export type PermissionAction = 'allow' | 'deny' | 'ask';

/** 权限规则条目 */
export interface PermissionRule {
  action: PermissionAction;
  /** 匹配模式：如 "Bash(npm:*)" 或 "Read"（工具名或工具名(参数前缀:*)） */
  pattern: string;
}

// ──────────────────────────────────────────
// 工具定义
// ──────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod 参数 Schema */
  paramsSchema: Record<string, ToolParameterSchema>;
  /** 是否需要二次审批 */
  requiresApproval: boolean;
  /** 风险等级 */
  riskLevel: RiskLevel;
  /** 是否只读（只读工具可并发执行） */
  readOnly: boolean;
  /** 工具处理函数 */
  handler: (params: Record<string, unknown>) => Promise<ToolHandlerResult>;
}

/** 工具处理返回 — 统一格式 */
export interface ToolHandlerResult {
  success: boolean;
  /** 给 LLM 看的结果文本（已经过 LLM-friendly 格式化） */
  output: string;
  /** 原始数据（用于日志/审计） */
  raw?: unknown;
}

// ──────────────────────────────────────────
// 权限配置
// ──────────────────────────────────────────

export interface PermissionConfig {
  allow: string[];
  deny: string[];
  ask: string[];
}

/** 默认权限：读放行，写询问 */
export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  allow: ['Read', 'Glob', 'Grep', 'search_docs', 'fetch_memory_context', 'tool_search'],
  deny: [],
  ask: ['Bash(rm -rf:*)', 'Edit', 'Write', 'create_doc', 'send_card', 'update_bitable_record'],
};

// ──────────────────────────────────────────
// Pipeline 上下文
// ──────────────────────────────────────────

export interface PipelineContext {
  toolName: string;
  rawInput: unknown;
  validatedInput: Record<string, unknown>;
  enrichedInput: Record<string, unknown>;
  permissionResult: PermissionAction;
  agentKey: string;
  taskId: string;
  config: PermissionConfig;
}

// ──────────────────────────────────────────
// 7 步管线实现
// ──────────────────────────────────────────

/**
 * Step 1: 参数格式验证
 * 课程对照：用 Zod 做类型校验，返回精确的错误路径
 */
function validateParams(
  tool: ToolDefinition,
  input: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { success: false, error: `参数应为对象，收到 ${typeof input}` };
  }

  const record = input as Record<string, unknown>;
  const errors: string[] = [];

  for (const [key, paramDef] of Object.entries(tool.paramsSchema)) {
    const value = record[key];
    if (value === undefined) {
      if (paramDef.required) {
        errors.push(`缺少必填参数 "${key}"`);
      }
      continue;
    }
    const result = paramDef.schema.safeParse(value);
    if (!result.success) {
      const zodError = result.error;
      // 提取精确的错误路径
      const detail = zodError.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      errors.push(`参数 "${key}" 格式错误: ${detail}`);
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      error: errors.join('\n'),
    };
  }

  // 只返回 schema 中定义的字段，忽略多余字段
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(tool.paramsSchema)) {
    if (record[key] !== undefined) {
      data[key] = record[key];
    }
  }
  return { success: true, data };
}

/**
 * Step 2: 业务逻辑校验
 * 课程对照：语义层面的检查，不只是类型检查
 */
function businessValidation(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  switch (toolName) {
    case 'read_file':
    case 'read': {
      const path = String(input['file_path'] ?? input['path'] ?? '');
      if (!path) return '缺少文件路径';
      // 检查路径是否包含非法字符
      if (path.includes('\0')) return '文件路径包含非法字符 (null byte)';
      // 路径遍历攻击检测
      if (path.includes('..') && !path.startsWith('/')) {
        return '不支持相对路径中的 ".." 语法，请使用绝对路径';
      }
      return null;
    }

    case 'edit_file':
    case 'edit': {
      const oldStr = String(input['old_string'] ?? input['search'] ?? '');
      if (!oldStr) return '缺少 old_string/search 内容';
      if (oldStr.length < 3) return `old_string 内容太短 (${oldStr.length} 字符)，可能导致误匹配，请提供更多上下文`;
      return null;
    }

    case 'bash':
    case 'execute': {
      const command = String(input['command'] ?? '');
      if (!command) return '缺少命令';
      // 检测危险命令
      const dangerousPatterns = [
        { pattern: /rm\s+-rf\s+\//, msg: '禁止执行 rm -rf /' },
        { pattern: /mkfs/, msg: '禁止执行格式化命令' },
        { pattern: /dd\s+if=/, msg: '禁止执行 dd 命令' },
        { pattern: /:\(\)\s*\{/, msg: '检测到 fork bomb' },
        { pattern: /\|bash\b/, msg: '禁止通过管道执行 bash' },
        { pattern: /\bsudo\b/, msg: '禁止使用 sudo' },
      ];
      for (const { pattern, msg } of dangerousPatterns) {
        if (pattern.test(command)) return msg;
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Step 3: 输入补全 + 标准化
 * 课程对照：不改原始输入，生成补全副本（保 Cache）
 */
function enrichInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const enriched = { ...input };

  switch (toolName) {
    case 'read_file':
    case 'read':
    case 'edit_file':
    case 'edit': {
      // 将相对路径转为绝对路径
      const pathKey = enriched['file_path'] !== undefined ? 'file_path' : 'path';
      const path = String(enriched[pathKey] ?? '');
      if (path && !path.startsWith('/') && !path.startsWith('~')) {
        // 项目根目录相对路径处理
        // 实际项目中应传入 cwd 上下文，这里标记保留
        enriched[pathKey] = path;
      }
      break;
    }
  }

  return enriched;
}

/**
 * Step 4: 前置 Hook (预留)
 * 课程对照：用户自定义脚本在工具执行前运行
 */

/**
 * Step 5: 权限检查
 * 课程对照：Allow > Deny > Ask，Deny 优先级最高
 */
function checkPermission(
  toolName: string,
  input: Record<string, unknown>,
  config: PermissionConfig,
): PermissionAction {
  // 构建匹配用的命令字符串（对 Bash 类工具）
  const command = String(input['command'] ?? input['cmd'] ?? '');

  // 1. 先检查 Deny 规则（最高优先级）
  for (const rule of config.deny) {
    if (matchPermissionRule(rule, toolName, command)) return 'deny';
  }

  // 2. 再检查 Allow 规则
  for (const rule of config.allow) {
    if (matchPermissionRule(rule, toolName, command)) return 'allow';
  }

  // 3. 都没匹配 → Ask
  return 'ask';
}

/**
 * 匹配权限规则模式
 * 支持：
 * - "Read" — 精确匹配工具名
 * - "Bash(npm:*)" — 工具名 + 参数前缀
 * - "Bash(git *)" — 工具名 + 参数通配
 */
function matchPermissionRule(pattern: string, toolName: string, command: string): boolean {
  // 简单匹配：只有工具名
  if (!pattern.includes('(')) {
    return pattern === toolName;
  }

  // 带参数的模式：ToolName(prefix:*)
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  if (!match || !match[1] || !match[2]) return false;

  const ruleTool = match[1];
  const ruleArgPattern = match[2];

  // 工具名不匹配
  if (ruleTool !== toolName) return false;

  // 参数通配匹配
  if (ruleArgPattern.endsWith('*')) {
    const prefix = ruleArgPattern.slice(0, -1);
    return command.startsWith(prefix);
  }

  // 精确参数匹配
  return command === ruleArgPattern;
}

/**
 * Step 6: 执行 + 结果截断
 * 课程对照：>50K 字符的结果截断并持久化到磁盘
 */
const MAX_RESULT_CHARS = 50_000;
const RESULTS_DIR = join(tmpdir(), 'jarvis-team-tool-results');

async function executeAndTruncate(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): Promise<ToolHandlerResult> {
  let result: ToolHandlerResult;

  try {
    result = await tool.handler(input);
  } catch (err: unknown) {
    // LLM-friendly 错误 — 课程：错误信息是给模型看的，不是给人看的
    const errorMsg = formatLLMError(tool.name, err);
    return { success: false, output: errorMsg };
  }

  // 结果截断
  if (result.output.length > MAX_RESULT_CHARS) {
    const hash = createHash('md5').update(result.output).digest('hex').slice(0, 8);
    const filename = `${tool.name}_${hash}.txt`;
    if (!existsSync(RESULTS_DIR)) {
      mkdirSync(RESULTS_DIR, { recursive: true });
    }
    const filepath = join(RESULTS_DIR, filename);
    writeFileSync(filepath, result.output, 'utf-8');

    result.output = `[结果已截断] 输出过长 (${result.output.length} 字符)，完整结果已保存到 ${filepath}。\n${result.output.slice(0, 2000)}\n...（共 ${result.output.length} 字符，仅显示前 2000 字符）`;
  }

  return result;
}

/**
 * 完整的 7 步管线入口 — 供 Agent Loop 调用
 * 返回给 LLM 看的字符串结果
 */
export async function runToolPipeline(
  toolName: string,
  rawInput: unknown,
  context: {
    agentKey: string;
    taskId: string;
    permissionConfig?: PermissionConfig;
  },
): Promise<string> {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    return formatLLMError(toolName, new Error(`未知工具: ${toolName}`));
  }

  // Step 1: 参数格式验证
  const validationResult = validateParams(tool, rawInput);
  if (!validationResult.success) {
    return validationResult.error;
  }
  const validatedInput = validationResult.data;

  // Step 2: 业务逻辑校验
  const bizError = businessValidation(toolName, validatedInput);
  if (bizError) {
    return bizError;
  }

  // Step 3: 输入补全 + 标准化
  const enrichedInput = enrichInput(toolName, validatedInput);

  // Step 4: 前置 Hook (预留)
  // TODO: 加载用户自定义 PreToolUse Hook 脚本

  // Step 5: 权限检查
  const permConfig = context.permissionConfig ?? DEFAULT_PERMISSION_CONFIG;
  const permission = checkPermission(toolName, enrichedInput, permConfig);
  if (permission === 'deny') {
    return `[权限拒绝] 操作被安全策略禁止: ${toolName}`;
  }
  if (permission === 'ask' && tool.readOnly === false) {
    // 需要审批 — 对 Phase 1 返回提示信息
    // TODO: 实际审批流程集成 (Phase 2)
    if (tool.requiresApproval) {
      return `[需要审批] 操作 ${toolName} 需要人工确认才能执行。请等待审批通过后重试。`;
    }
  }

  // Step 6: 执行 + 结果截断
  const result = await executeAndTruncate(tool, enrichedInput);

  // Step 7: 后置 Hook (预留)
  // TODO: 加载用户自定义 PostToolUse Hook 脚本

  return result.output;
}

// ──────────────────────────────────────────
// 工具注册表 + Handler
// ──────────────────────────────────────────

/** 工具注册表 */
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {};

/**
 * 注册一个工具（含完整定义 + handler）
 */
export function registerTool(def: ToolDefinition): void {
  TOOL_REGISTRY[def.name] = def;
}

/**
 * 批量注册工具
 */
export function registerTools(defs: ToolDefinition[]): void {
  for (const def of defs) {
    registerTool(def);
  }
}

// ──────────────────────────────────────────
// FLU 工具 Handler 实现
// ──────────────────────────────────────────

/**
 * LLM-friendly 错误格式化
 * 课程对照：不给 ENOENT，给"文件不存在，当前目录有..."
 */
function formatLLMError(toolName: string, err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    // 文件不存在的场景 — 给出纠正上下文
    if (msg.includes('ENOENT') || msg.includes('no such file') || msg.includes('not found')) {
      return `文件或路径不存在：${msg}。请先检查路径是否正确，或使用 list_directory/Read 查看当前目录内容。`;
    }
    // 权限错误
    if (msg.includes('EACCES') || msg.includes('permission denied')) {
      return `权限不足：${msg}。请更换一个你有权限的文件或路径。`;
    }
    // 超时
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      return `操作超时：${msg}。请简化任务或分步执行。`;
    }
    return `执行出错：${msg}`;
  }
  return `执行出错：${String(err)}`;
}

// ──────────────────────────────────────────
// 内置工具注册
// ──────────────────────────────────────────

function setupBuiltinTools(): void {
  registerTool({
    name: 'send_group_message',
    description: '向飞书群发送文本消息',
    paramsSchema: {
      chat_id: { schema: z.string(), description: '飞书群聊 ID', required: true },
      content: { schema: z.string(), description: '消息内容', required: true },
    },
    requiresApproval: false,
    riskLevel: 'medium',
    readOnly: false,
    handler: async (params) => {
      // TODO: 接入真实飞书 API
      return {
        success: true,
        output: `[stub] 已向群 ${params['chat_id']} 发送消息`,
      };
    },
  });

  registerTool({
    name: 'send_card',
    description: '向飞书群发送交互卡片',
    paramsSchema: {
      chat_id: { schema: z.string(), description: '飞书群聊 ID', required: true },
      card: { schema: z.record(z.unknown()), description: '卡片 JSON 内容', required: true },
    },
    requiresApproval: true,
    riskLevel: 'high',
    readOnly: false,
    handler: async (params) => {
      // TODO: 接入真实飞书 API
      return {
        success: true,
        output: `[stub] 已向群 ${params['chat_id']} 发送卡片`,
      };
    },
  });

  registerTool({
    name: 'create_doc',
    description: '创建飞书文档',
    paramsSchema: {
      title: { schema: z.string(), description: '文档标题', required: true },
      content: { schema: z.string().optional(), description: '文档初始内容，支持 Markdown', required: false },
    },
    requiresApproval: true,
    riskLevel: 'high',
    readOnly: false,
    handler: async (params) => {
      // TODO: 接入真实飞书 API
      return {
        success: true,
        output: `[stub] 已创建文档: ${params['title']}`,
      };
    },
  });

  registerTool({
    name: 'search_docs',
    description: '搜索飞书文档与知识库',
    paramsSchema: {
      query: { schema: z.string(), description: '搜索关键词', required: true },
      limit: { schema: z.number().min(1).max(50).optional(), description: '返回结果数上限', required: false },
    },
    requiresApproval: false,
    riskLevel: 'low',
    readOnly: true,
    handler: async (params) => {
      // TODO: 接入真实飞书 API
      return {
        success: true,
        output: `[stub] 搜索 "${params['query']}" 的结果：暂无数据`,
      };
    },
  });

  registerTool({
    name: 'fetch_memory_context',
    description: '获取用户偏好与项目记忆',
    paramsSchema: {
      scope: { schema: z.enum(['global', 'team', 'project', 'user']), description: '记忆范围', required: true },
    },
    requiresApproval: false,
    riskLevel: 'low',
    readOnly: true,
    handler: async () => {
      return {
        success: true,
        output: '[stub] 暂无记忆数据',
      };
    },
  });

  registerTool({
    name: 'tool_search',
    description: '动态发现可用工具（延迟发现机制）。注意：这是元工具，用于查询其他工具的完整定义。',
    paramsSchema: {
      query: { schema: z.string(), description: '搜索关键词或工具名前缀', required: true },
    },
    requiresApproval: false,
    riskLevel: 'low',
    readOnly: true,
    handler: async (params) => {
      const query = String(params['query'] ?? '').toLowerCase();
      const matches = Object.entries(TOOL_REGISTRY)
        .filter(([name, def]) =>
          name.toLowerCase().includes(query) ||
          def.description.toLowerCase().includes(query),
        )
        .slice(0, 10)
        .map(([name, def]) => `- ${name}: ${def.description}（风险: ${def.riskLevel}，需审批: ${def.requiresApproval}）`);

      if (matches.length === 0) {
        return {
          success: true,
          output: `未找到匹配 "${query}" 的工具。可用工具列表：\n${Object.entries(TOOL_REGISTRY).map(([name, def]) => `- ${name}: ${def.description}`).join('\n')}`,
        };
      }

      return {
        success: true,
        output: `找到 ${matches.length} 个匹配工具:\n${matches.join('\n')}`,
      };
    },
  });

  registerTool({
    name: 'request_human_approval',
    description: '请求人类审批某个操作',
    paramsSchema: {
      action: { schema: z.string(), description: '需要审批的操作描述', required: true },
      reason: { schema: z.string().optional(), description: '为什么需要审批', required: false },
    },
    requiresApproval: true,
    riskLevel: 'high',
    readOnly: false,
    handler: async (params) => {
      return {
        success: true,
        output: `[stub] 已请求审批: ${params['action']}（等待人工确认）`,
      };
    },
  });
}

// ──────────────────────────────────────────
// 管理工具 - Agent CRUD
// ──────────────────────────────────────────

const AGENTS_DIR = join(process.cwd(), 'agents');

function setupManagementTools(): void {
  registerTool({
    name: 'list_agents',
    description: '列出所有已注册的 Agent/Bot。返回每个 Agent 的 ID 和显示名。',
    paramsSchema: {},
    requiresApproval: false,
    riskLevel: 'low',
    readOnly: true,
    handler: async () => {
      if (!existsSync(AGENTS_DIR)) {
        return { success: true, output: '暂无 Agent。使用 create_agent 创建一个。' };
      }
      const agents = readdirSync(AGENTS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
      if (agents.length === 0) {
        return { success: true, output: '暂无 Agent。使用 create_agent 创建一个。' };
      }
      const lines = agents.map(id => {
        try {
          const raw = readFileSync(join(AGENTS_DIR, `${id}.json`), 'utf-8');
          const cfg = JSON.parse(raw);
          return `- ${id}: ${cfg.displayName ?? '未知'}${cfg.description ? ` — ${cfg.description}` : ''}`;
        } catch {
          return `- ${id}: (读取失败)`;
        }
      });
      return { success: true, output: `已注册 ${agents.length} 个 Agent:\n${lines.join('\n')}` };
    },
  });

  registerTool({
    name: 'create_agent',
    description: '创建新的 Agent/Bot。当用户说"创建一个新 Bot/机器人/Agent/助手"时调用。需要用户提供名称和角色描述。',
    paramsSchema: {
      name: { schema: z.string().min(1).max(32), description: 'Bot 名称，如"数据观察员"', required: true },
      description: { schema: z.string().min(1).max(500), description: 'Bot 的角色描述，用户说了什么、这个 Bot 负责什么', required: true },
      voiceStyle: { schema: z.string().max(200).optional(), description: '语气风格（可选），如"数据驱动、只给量化结论"', required: false },
    },
    requiresApproval: true,
    riskLevel: 'high',
    readOnly: false,
    handler: async (params) => {
      const name = String(params['name']);
      const description = String(params['description']);
      const voiceStyle = params['voiceStyle'] ? String(params['voiceStyle']) : '';
      const agentId = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'agent';

      // 检查是否已存在
      const filePath = join(AGENTS_DIR, `${agentId}.json`);
      if (existsSync(filePath)) {
        return { success: false, output: `Agent "${name}" (${agentId}) 已存在。如需修改请用 edit_agent 工具。` };
      }

      // 构造配置
      const corePrompt = `你是 ${name}。${description}`;
      const config = {
        id: agentId,
        displayName: name,
        description,
        persona: {
          corePrompt,
          voiceStyle: voiceStyle || '默认',
        },
        toolScope: {
          coreTools: ['search_docs', 'send_group_message', 'fetch_memory_context', 'tool_search'],
          stageTools: {},
          approvalRequired: ['create_doc', 'send_card'],
        },
        speakRules: {
          canInitiate: false,
          triggers: ['result_ready'],
          cooldownMs: 30000,
        },
      };

      if (!existsSync(AGENTS_DIR)) {
        mkdirSync(AGENTS_DIR, { recursive: true });
      }
      writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

      return {
        success: true,
        output: [
          `✅ 已创建 Agent: ${name} (${agentId})`,
          '',
          '接下来：',
          '1. 去飞书开发者后台注册这个 Bot → https://open.feishu.cn/app',
          '2. 注册后把 App ID 和 App Secret 发给我',
          '3. 我会帮你绑定，之后就能用了',
          '',
          '如需修改人设或配置，随时告诉我。',
        ].join('\n'),
      };
    },
  });

  registerTool({
    name: 'edit_agent',
    description: '修改已有 Agent 的配置。只填需要改的字段，不填的字段保持不变。',
    paramsSchema: {
      agentId: { schema: z.string(), description: '要修改的 Agent ID', required: true },
      displayName: { schema: z.string().max(32).optional(), description: '新的显示名称', required: false },
      corePrompt: { schema: z.string().max(2000).optional(), description: '新的角色定义 System Prompt', required: false },
      voiceStyle: { schema: z.string().max(200).optional(), description: '新的语气风格', required: false },
      description: { schema: z.string().max(500).optional(), description: '新的简短描述', required: false },
    },
    requiresApproval: false,
    riskLevel: 'medium',
    readOnly: false,
    handler: async (params) => {
      const agentId = String(params['agentId']);
      const filePath = join(AGENTS_DIR, `${agentId}.json`);
      if (!existsSync(filePath)) {
        return { success: false, output: `Agent "${agentId}" 不存在。使用 create_agent 创建。` };
      }

      const config = JSON.parse(readFileSync(filePath, 'utf-8'));

      // 只覆盖传了的字段
      if (params['displayName']) config.displayName = params['displayName'];
      if (params['corePrompt']) config.persona.corePrompt = params['corePrompt'];
      if (params['voiceStyle']) config.persona.voiceStyle = params['voiceStyle'];
      if (params['description']) config.description = params['description'];

      writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

      return { success: true, output: `✅ 已更新 Agent: ${agentId}\n下次对话生效。` };
    },
  });

  registerTool({
    name: 'delete_agent',
    description: '删除一个 Agent。删除后无法恢复。注意不能删除 assistant（默认助手）。',
    paramsSchema: {
      agentId: { schema: z.string(), description: '要删除的 Agent ID', required: true },
    },
    requiresApproval: true,
    riskLevel: 'high',
    readOnly: false,
    handler: async (params) => {
      const agentId = String(params['agentId']);
      if (agentId === 'assistant') {
        return { success: false, output: '不能删除默认助手。你可以用 edit_agent 修改它，或先创建一个新的 Agent 替代它。' };
      }
      const filePath = join(AGENTS_DIR, `${agentId}.json`);
      if (!existsSync(filePath)) {
        return { success: false, output: `Agent "${agentId}" 不存在。` };
      }
      rmSync(filePath);
      return { success: true, output: `✅ 已删除 Agent: ${agentId}` };
    },
  });

  registerTool({
    name: 'bind_agent_credentials',
    description: '将飞书 Bot 凭证绑定到 Agent。用户在飞书开发者后台注册 Bot 后，把 App ID 和 App Secret 发过来时调用。',
    paramsSchema: {
      agentId: { schema: z.string(), description: '要绑定凭证的 Agent ID', required: true },
      appId: { schema: z.string(), description: '飞书 Bot 的 App ID', required: true },
      appSecret: { schema: z.string(), description: '飞书 Bot 的 App Secret', required: true },
      verificationToken: { schema: z.string().optional(), description: '飞书 Bot 的 Verification Token', required: false },
    },
    requiresApproval: true,
    riskLevel: 'high',
    readOnly: false,
    handler: async (params) => {
      const agentId = String(params['agentId']);
      const filePath = join(AGENTS_DIR, `${agentId}.json`);
      if (!existsSync(filePath)) {
        return { success: false, output: `Agent "${agentId}" 不存在。请先创建。` };
      }
      const config = JSON.parse(readFileSync(filePath, 'utf-8'));
      config.feishuBot = {
        appId: String(params['appId']),
        appSecret: String(params['appSecret']),
        verificationToken: params['verificationToken'] ? String(params['verificationToken']) : '',
      };
      writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true, output: `✅ 已绑定！${config.displayName ?? agentId} 现在可以接收消息了。\n请把它拉进群，然后就可以 @${config.displayName ?? agentId} 跟它对话。` };
    },
  });
}

// 启动时注册
setupBuiltinTools();
setupManagementTools();

// ──────────────────────────────────────────
// 导出 Anthropic Tool 格式
// 供 Agent Loop 组装工具列表
// ──────────────────────────────────────────

import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages/messages.js';

/**
 * 将内部工具定义转为 Anthropic Tool 格式
 */
export function toAnthropicTools(toolNames?: string[]): AnthropicTool[] {
  const names = toolNames ?? Object.keys(TOOL_REGISTRY);
  return names
    .filter(n => TOOL_REGISTRY[n])
    .map(name => {
      const def = TOOL_REGISTRY[name]!;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, paramDef] of Object.entries(def.paramsSchema)) {
        properties[key] = {
          type: paramDef.schema.description?.toLowerCase() ?? 'string',
          description: paramDef.description,
        };
        if (paramDef.required) {
          required.push(key);
        }
      }

      return {
        name: def.name,
        description: def.description,
        input_schema: {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        },
      } as AnthropicTool;
    });
}
