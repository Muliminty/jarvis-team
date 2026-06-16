// 飞书多Agent协作系统 主入口
//
// 架构：Feishu → Gateway → Agent Loop → Tool System
// Agent 配置存储在 agents/*.json，启动时自动创建默认 assistant

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import SDK from '@larksuiteoapi/node-sdk';
const { WSClient, EventDispatcher } = SDK;
import { normalizeEvent } from './gateway/index.js';
import { classifyIntent, planSteps } from './orchestrator/index.js';
import { loadAgent, listAgents, loadAgentConfig, assembleSystemPrompt, getActiveTools, AGENTS_DIR } from './agent-runtime/index.js';
import { createTask as createTaskRecord, createStep } from './state-service/index.js';
import { runAgentLoop, DEFAULT_LOOP_CONFIG } from './agent-loop/index.js';
import { runToolPipeline, toAnthropicTools } from './tool-service/index.js';
import { CHAT_PAGE } from './web/index.js';

// ── 飞书事件签名校验 ──
// 签名算法：sha256(timestamp + nonce + verification_token + body)
// 参考：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case

function verifyFeishuSignature(
  verificationToken: string,
  timestamp: string,
  nonce: string,
  body: string,
  expectedSignature: string,
): boolean {
  const raw = `${timestamp}${nonce}${verificationToken}${body}`;
  const computed = createHmac('sha256', verificationToken).update(raw).digest('hex');
  return computed === expectedSignature;
}

// ── 聊天会话注册表 ──
// 自动记录飞书事件中出现的 chat_id，支持群聊和私聊
// 后续 LLM 可通过 send_group_message 往任意已记录的会话发消息

interface ChatSession {
  chatId: string;
  type: 'group' | 'p2p';
  name?: string;
  initiatorOpenId?: string;
  lastSeen: Date;
}

const chatSessions = new Map<string, ChatSession>();

function recordChatSession(event: ReturnType<typeof normalizeEvent>): void {
  if (!event) return;
  const chatId = event.chatId;
  if (!chatId || chatId === 'unknown') return;

  const existing = chatSessions.get(chatId);
  chatSessions.set(chatId, {
    chatId,
    type: event.chatType === 'group' ? 'group' : 'p2p',
    name: existing?.name,
    initiatorOpenId: event.initiatorOpenId,
    lastSeen: new Date(),
  });
}

/** 生成 chat_id 注入文本，追加到 System Prompt 中 */
function buildChatContext(): string {
  if (chatSessions.size === 0) return '';

  const lines: string[] = ['', '已知飞书会话：'];
  for (const [id, session] of chatSessions) {
    const label = session.type === 'p2p' ? '私聊' : `群聊${session.name ? `「${session.name}」` : ''}`;
    lines.push(`- ${label}: chat_id="${id}"`);
  }
  lines.push('发消息时使用对应的 chat_id。若用户在私聊中对话，也用该 chat_id 回复。');
  return lines.join('\n');
}

// ── 启动时确保默认 Agent 存在 ──

function ensureDefaultAgent(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
  const defaultPath = join(AGENTS_DIR, 'assistant.json');
  if (!existsSync(defaultPath)) {
    // 读取 .env 中的飞书凭证（可选）
    const envFeishuBot = process.env['FEISHU_APP_ID'] && process.env['FEISHU_APP_SECRET']
      ? {
          appId: process.env['FEISHU_APP_ID'],
          appSecret: process.env['FEISHU_APP_SECRET'],
          verificationToken: process.env['FEISHU_VERIFICATION_TOKEN'] ?? '',
        }
      : undefined;
    if (envFeishuBot) console.log('  Feishu bot credentials found in .env');
    const defaultConfig = {
      ...(envFeishuBot ? { feishuBot: envFeishuBot } : {}),
      id: 'assistant',
      displayName: '助手',
      description: 'Jarvis Team 默认助手。可完成日常任务，也可创建和管理其他 Agent。',
      persona: {
        corePrompt: '你是 Jarvis Team 助手，负责协助用户完成日常任务：整理信息、搜索文档、创建内容、管理日程。同时你也可以帮助用户创建和管理其他 Agent——当用户说"创建一个新 Bot"或"新建一个 Agent"时，使用 create_agent 工具。',
        voiceStyle: '简洁、直接、有条理',
      },
      toolScope: {
        coreTools: [
          'send_group_message', 'search_docs', 'fetch_memory_context', 'tool_search',
          'create_agent', 'edit_agent', 'delete_agent', 'list_agents', 'bind_agent_credentials',
        ],
        stageTools: {},
        approvalRequired: ['create_agent', 'delete_agent'],
      },
      speakRules: {
        canInitiate: false,
        triggers: ['result_ready'],
        cooldownMs: 10000,
      },
    };
    writeFileSync(defaultPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    console.log('  Created default agent: assistant');
  }
}

// ── 启动 ──

ensureDefaultAgent();

const app = new Hono();
app.use('/api/*', cors());

// ── 飞书事件回调端点 ──
app.post('/feishu/event', async (c) => {
  const body = await c.req.json();

  // URL Challenge：飞书首次配置回调地址时的握手验证
  // 收到 { challenge, token, type: "url_verification" } → 返回 { challenge }
  if (body.type === 'url_verification' && body.challenge) {
    return c.json({ challenge: body.challenge });
  }

  // 签名校验（可选但推荐）
  const verificationToken = process.env['FEISHU_VERIFICATION_TOKEN'];
  if (verificationToken) {
    const timestamp = c.req.header('X-Lark-Request-Timestamp');
    const nonce = c.req.header('X-Lark-Request-Nonce');
    const signature = c.req.header('X-Lark-Signature');
    if (timestamp && nonce && signature) {
      const valid = verifyFeishuSignature(verificationToken, timestamp, nonce, JSON.stringify(body), signature);
      if (!valid) {
        console.warn('[gateway] signature verification failed');
        return c.json({ code: -1, msg: 'signature verification failed' }, 403);
      }
    }
  }

  const event = normalizeEvent(body);
  if (!event) {
    return c.json({ code: 0, msg: 'duplicate or invalid event' });
  }

  // 自动记录 chat_id（群聊/私聊都会被登记）
  recordChatSession(event);

  const intent = classifyIntent(event);
  console.log('[orchestrator] intent:', intent);

  const task = createTaskRecord({
    sessionId: event.sessionId,
    title: `任务-${event.id}`,
    taskType: intent.taskType,
    status: 'new',
    ownerAgent: 'assistant',
    coordinationMode: intent.coordinationMode,
    priority: 'medium',
    inputPayload: event.payload,
    resultPayload: null,
    createdBy: event.initiatorOpenId,
  });

  const stepDefs = planSteps(intent.taskType);
  for (const def of stepDefs) {
    createStep({
      taskId: task.id,
      stepType: def.stepType,
      assignedAgent: def.assignedAgent,
      input: null,
      output: null,
      dependsOn: def.dependsOn,
    });
  }

  console.log(`[orchestrator] created task ${task.id} with ${stepDefs.length} steps`);

  // 异步执行 Agent Loop 并回复飞书群
  // 飞书要求 3 秒内响应，所以先返回 { code: 0 }，再后台处理
  const chatId = event.chatId;
  const userMessage = extractFeishuText(event);
  const agentId = 'assistant';

  if (userMessage && chatId && chatId !== 'unknown') {
    // 不 await — 让回复异步进行
    processFeishuMessage(agentId, userMessage, chatId).catch(err => {
      console.error('[feishu] agent loop failed:', err);
    });
  }

  return c.json({ code: 0, taskId: task.id, steps: stepDefs.length });
});

// ── 从飞书事件中提取文本内容 ──
function extractFeishuText(event: ReturnType<typeof normalizeEvent>): string {
  if (!event) return '';
  const msg = event.payload as { content?: string; text?: string; message?: { content?: string; msg_type?: string } };
  // content 可能在顶层(HTTP回调)也可能嵌套在 message 中(WS长连接)
  const raw = msg?.content ?? msg?.message?.content ?? msg?.text ?? '';
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    // 提取 text 类型的消息体
    if (parsed.text) return parsed.text;
    if (typeof parsed === 'string') return parsed;
    return raw;
  } catch {
    return raw;
  }
}

// ── 处理飞书消息：Agent Loop → 回复 ──
async function processFeishuMessage(agentId: string, userMessage: string, chatId: string): Promise<void> {
  // 1. 加载 Agent Profile
  const profile = loadAgent(agentId);
  if (!profile) {
    console.error(`[feishu] unknown agent: ${agentId}`);
    return;
  }

  // 2. 获取可用工具
  const activeTools = getActiveTools(profile, 'reporting');

  // 3. 组装 System Prompt — 注入所有已知 chat_id 让 LLM 知道往哪发
  const systemPrompt = assembleSystemPrompt(profile, {
    taskType: 'ask',
    currentStep: 'execute',
    activeTools,
  }) + [
    '',
    `当前会话 chat_id = "${chatId}"，回复消息使用此 chat_id。`,
    buildChatContext(),
  ].filter(Boolean).join('\n');

  // 4. 转 Anthropic Tool 格式
  const tools = toAnthropicTools(activeTools);

  // 5. 构造消息
  const messages = [{ role: 'user' as const, content: userMessage }];

  // 6. 执行 Agent Loop
  const result = await runAgentLoop(
    systemPrompt,
    messages as any,
    tools,
    async (name, params) => {
      const output = await runToolPipeline(name, params, {
        agentKey: agentId,
        taskId: chatId,
      });
      return output;
    },
    { ...DEFAULT_LOOP_CONFIG, maxTurns: 10, tokenBudget: 20_000 },
  );

  // 7. 提取最后的 assistant 文本
  const lastAssistant = result.messages
    .filter(m => m.role === 'assistant')
    .pop();

  let replyText = '';
  if (lastAssistant) {
    if (typeof lastAssistant.content === 'string') {
      replyText = lastAssistant.content;
    } else if (Array.isArray(lastAssistant.content)) {
      replyText = (lastAssistant.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
    }
  }

  if (!replyText) {
    replyText = `任务已完成 (${result.exitReason.type})`;
  }

  // 8. 通过 lark-cli 回复飞书群
  const sendResult = await runToolPipeline('send_group_message', {
    chat_id: chatId,
    content: replyText,
  }, {
    agentKey: agentId,
    taskId: chatId,
  });

  console.log(`[feishu] replied to ${chatId}: ${sendResult.slice(0, 100)}`);
}

// ── Chat 对话端点 ──
app.post('/api/chat', async (c) => {
  const body = await c.req.json();
  const userMessage: string = body.message ?? '';
  const agentId: string = body.agent ?? 'assistant';

  if (!userMessage) {
    return c.json({ error: 'message is required' }, 400);
  }

  // 1. 加载 Agent Profile
  const profile = loadAgent(agentId);
  if (!profile) {
    return c.json({ error: `unknown agent: ${agentId}`, knownAgents: listAgents() }, 404);
  }

  // 2. 获取可用工具
  const activeTools = getActiveTools(profile, 'reporting');

  // 3. 组装 System Prompt
  const systemPrompt = assembleSystemPrompt(profile, {
    taskType: 'ask',
    currentStep: 'execute',
    activeTools,
  });

  // 4. 转 Anthropic Tool 格式
  const tools = toAnthropicTools(activeTools);

  // 5. 构造消息
  const messages = [{ role: 'user' as const, content: userMessage }];

  // 6. 执行 Agent Loop
  const result = await runAgentLoop(
    systemPrompt,
    messages as any,
    tools,
    async (name, params) => {
      const output = await runToolPipeline(name, params, {
        agentKey: agentId,
        taskId: 'demo',
      });
      return output;
    },
    { ...DEFAULT_LOOP_CONFIG, maxTurns: 10, tokenBudget: 20_000, baseURL: process.env['ANTHROPIC_BASE_URL'] },
  );

  return c.json({
    messages: result.messages,
    exitReason: result.exitReason,
    usage: result.usage,
  });
});

// ── 健康检查 ──
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    agents: listAgents(),
    anthropicKeySet: !!process.env['ANTHROPIC_API_KEY'],
  });
});

// ── Agent 信息查询 ──
app.get('/agents/:id', (c) => {
  const id = c.req.param('id');
  const config = loadAgentConfig(id);
  if (!config) return c.json({ error: 'not found', knownAgents: listAgents() }, 404);
  return c.json({
    id: config.id,
    displayName: config.displayName,
    description: config.description,
    tools: config.toolScope.coreTools,
    speakRules: config.speakRules,
  });
});

// ── Web 管理界面 ──
app.get('/', (c) => c.html(CHAT_PAGE));

// ── 飞书 Bot 凭证绑定（Web 用） ──
app.post('/api/agents/:id/feishu-bot', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { appId, appSecret, verificationToken } = body;

  if (!appId || !appSecret) {
    return c.json({ success: false, error: 'appId 和 appSecret 必填' }, 400);
  }

  const filePath = join(AGENTS_DIR, `${id}.json`);
  if (!existsSync(filePath)) {
    return c.json({ success: false, error: `Agent ${id} 不存在` }, 404);
  }

  const config = JSON.parse(readFileSync(filePath, 'utf-8'));
  config.feishuBot = { appId, appSecret, verificationToken: verificationToken ?? '' };
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

  return c.json({ success: true, agentId: id });
});

// ── 工具列表 ──
app.get('/api/tools', (c) => {
  const tools = toAnthropicTools();
  return c.json({ count: tools.length, tools: tools.map(t => t.name) });
});

// ── 消息轮询引擎（内网部署方案）──
// 内网服务器飞书推不过来，主动拉取所有会话的消息
// 定时扫描 → 发现新消息 → Agent Loop → 自动回复

const POLL_INTERVAL_MS = 5000; // 轮询间隔
const processedMessageIds = new Set<string>();

/** 从飞书消息对象中提取纯文本 */
function extractMessageText(msg: { msg_type?: string; content?: string }): string {
  if (!msg.content) return '';
  if (msg.msg_type === 'text') {
    try {
      const parsed = JSON.parse(msg.content);
      return parsed.text ?? '';
    } catch {
      return msg.content;
    }
  }
  // post / interactive 等富文本类型，提取 text 片段
  try {
    const parsed = JSON.parse(msg.content);
    if (parsed.title) return parsed.title;
    if (parsed.content) {
      const texts: string[] = [];
      const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        const arr = Array.isArray(node) ? node : [node];
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          if (Array.isArray(item)) { walk(item); continue; }
          const obj = item as Record<string, unknown>;
          if (obj.tag === 'text' && typeof obj.text === 'string') texts.push(obj.text);
          if (Array.isArray(obj.elements)) walk(obj.elements);
          if (Array.isArray(obj.content)) walk(obj.content);
        }
      };
      walk(parsed.content);
      return texts.join('');
    }
    return '';
  } catch {
    return '';
  }
}

/** seed 已知会话到 chatSessions（启动时 + 从 chat-list 返回填充） */
function seedChatSession(chatId: string, type: 'group' | 'p2p', name?: string): void {
  if (chatSessions.has(chatId)) return;
  chatSessions.set(chatId, { chatId, type, name, lastSeen: new Date() });
}

/** 从 lark-cli JSON 输出解析 chat-list 并 seed */
function syncChatList(chats: Array<{ chat_id: string; name?: string; chat_mode?: string }>): void {
  for (const chat of chats) {
    seedChatSession(
      chat.chat_id,
      chat.chat_mode === 'p2p' ? 'p2p' : 'group',
      chat.name,
    );
  }
}

async function pollMessages(profile: string): Promise<void> {
  // 1. 拉取所有可用会话
  const chatListResult = await execCliAndParse(profile, ['im', '+chat-list', '--page-size', '50']);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (chatListResult as any)?.data;
  const apiChats: Array<{ chat_id: string; name?: string; chat_mode?: string }> = data?.chats ?? [];
  syncChatList(apiChats);

  // 2. 合并 chatSessions 中的所有已知会话（包括手动 seed 的私聊）
  const allChatIds = [...chatSessions.keys()];

  // 3. 对每个会话拉最新消息
  for (const chatId of allChatIds) {
    const result = await execCliAndParse(profile, [
      'im', '+chat-messages-list',
      '--chat-id', chatId,
      '--page-size', '8',
    ]);

    interface FeishuMessage {
      message_id: string;
      msg_type?: string;
      content?: string;
      chat_id: string;
      sender?: { sender_type?: string; id?: string; name?: string };
      mentions?: Array<{ name?: string }>;
    }
    const messages: FeishuMessage[] = ((result as any)?.data?.messages as FeishuMessage[]) ?? [];

    // 消息是按时间倒序的（最新在前），我们需要正序处理
    const newMessages = messages
      .reverse()
      .filter(msg => {
        if (processedMessageIds.has(msg.message_id)) return false;
        if (msg.sender?.sender_type === 'app') return false; // 跳过 bot 自己的消息
        return true;
      });

    for (const msg of newMessages) {
      processedMessageIds.add(msg.message_id);
      const text = extractMessageText(msg);
      if (!text) continue;

      // 更新 chat_id 注册表
      seedChatSession(msg.chat_id, chatSessions.get(msg.chat_id)?.type ?? 'group');

      console.log(`[poller] new message in ${msg.chat_id}: ${text.slice(0, 60)}`);

      // 异步交给 Agent Loop 处理
      processFeishuMessage(profile, text, msg.chat_id).catch(err => {
        console.error(`[poller] agent loop error for ${msg.chat_id}:`, err);
      });
    }
  }

  // 清理旧 processed IDs（防止内存泄漏）
  if (processedMessageIds.size > 1000) {
    const toDelete = processedMessageIds.size - 500;
    let count = 0;
    for (const id of processedMessageIds) {
      if (count >= toDelete) break;
      processedMessageIds.delete(id);
      count++;
    }
  }
}

/** 执行 lark-cli 并解析 JSON 输出 */
async function execCliAndParse(profile: string, args: string[]): Promise<Record<string, unknown> | null> {
  try {
    const { output, success } = await new Promise<{ output: string; success: boolean }>((resolve) => {
      const child = spawn('lark-cli', ['--profile', profile, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('close', (code: number) => resolve({ output: stdout.trim(), success: code === 0 }));
      child.on('error', () => resolve({ output: '', success: false }));
    });
    if (!success || !output) return null;
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/** 启动轮询循环 */
function startPolling(profile: string, intervalMs: number): void {
  // 首次启动时 seed 已知私聊 chat_id（防止 chat-list 不包含 P2P 会话）
  seedChatSession('oc_9f86de17a0bb3a422335a79a14071a5f', 'p2p', 'Muliminty');

  const tick = async () => {
    try {
      await pollMessages(profile);
    } catch (err) {
      console.error('[poller] tick error:', err);
    }
    setTimeout(tick, intervalMs);
  };

  // 立即执行第一次，然后定时循环
  tick();
  console.log(`[poller] started, interval=${intervalMs}ms, profile=${profile}`);
}

// ── 飞书 WebSocket 长连接网关 ──
// 替代轮询：应用主动连接飞书服务器，实时接收事件推送
// 内网部署无需公网域名，SDK 内置心跳和自动重连

function startWsGateway(profile: string): void {
  const appId = process.env['FEISHU_APP_ID'];
  const appSecret = process.env['FEISHU_APP_SECRET'];

  if (!appId || !appSecret) {
    console.log('[ws-gateway] FEISHU_APP_ID/FEISHU_APP_SECRET not set, skipping WebSocket');
    return;
  }

  const dispatcher = new EventDispatcher({
    encryptKey: '',           // 长连接模式无需加密
    verificationToken: '',    // 长连接模式无需验证 token
  });

  let wsEventCount = 0;

  dispatcher.register({
    'im.message.receive_v1': (rawEvent: unknown) => {
      wsEventCount++;
      console.log(`[ws-gateway] event #${wsEventCount} received`);
      const body = rawEvent as Record<string, unknown>;

      // WS 长连接事件是扁平结构，转换为 HTTP 回调的嵌套格式
      const wsBody = body as Record<string, unknown>;
      const httpFormat = {
        header: {
          event_id: wsBody.event_id as string,
          event_type: wsBody.event_type as string,
          create_time: wsBody.create_time as string,
          token: (wsBody.token as string) ?? '',
        },
        event: {
          sender: wsBody.sender,
          message: wsBody.message,
        },
      };

      const event = normalizeEvent(httpFormat as Parameters<typeof normalizeEvent>[0]);
      if (!event) {
        console.log('[ws-gateway] duplicate or invalid event, skipped');
        return;
      }

      recordChatSession(event);

      const text = extractFeishuText(event);
      if (text && event.chatId && event.chatId !== 'unknown') {
        console.log(`[ws-gateway] ${event.chatType === 'p2p' ? '私聊' : '群聊'} ${event.chatId}: ${text.slice(0, 50)}`);
        processFeishuMessage(profile, text, event.chatId).catch(err => {
          console.error('[ws-gateway] agent loop error:', err);
        });
      }
    },
  });

  const ws = new WSClient({
    appId,
    appSecret,
    domain: SDK.Domain.Feishu,
  });

  // SDK 内置自动重连，无需额外处理
  ws.start({ eventDispatcher: dispatcher }).then(() => {
    console.log('[ws-gateway] WebSocket 长连接已建立，实时接收飞书事件');
    // 每 30 秒打印一次心跳，确认连接存活
    const heartbeat = setInterval(() => {
      const status = (ws as unknown as Record<string, () => string>).getConnectionStatus?.() ?? 'unknown';
      console.log(`[ws-gateway] heartbeat - status: ${JSON.stringify(status)}`);
    }, 30_000);
    // 防止定时器阻止进程退出
    heartbeat.unref();
  }).catch((err: Error) => {
    console.error('[ws-gateway] WebSocket 连接失败:', err.message);
    console.log('[ws-gateway] 降级到轮询模式...');
    startPolling(profile, POLL_INTERVAL_MS);
  });

  // 保持 wsClient 引用防止被 GC
  (globalThis as Record<string, unknown>).__wsClient = ws;
}

// ── 启动 ──
const port = Number(process.env['PORT']) || 3000;
console.log(`Jarvis Team server starting on port ${port}...`);
console.log(`  Web UI: http://localhost:${port}`);
console.log(`  Agents: ${listAgents().join(', ')}`);
console.log(`  ANTHROPIC_API_KEY: ${process.env['ANTHROPIC_API_KEY'] ? 'set ✓' : 'not set (demo mode)'}`);
console.log(`  FEISHU_BOT: ${process.env['FEISHU_APP_ID'] ? `set (${process.env['FEISHU_APP_ID']})` : 'not set'}`);

// 优先 WebSocket 长连接，失败自动降级轮询
startWsGateway('assistant');

serve({ fetch: app.fetch, port });
