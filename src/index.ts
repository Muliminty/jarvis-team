// 飞书多Agent协作系统 主入口
//
// 架构：Feishu → Gateway → Agent Loop → Tool System
// Agent 配置存储在 agents/*.json，启动时自动创建默认 assistant

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeEvent } from './gateway/index.js';
import { classifyIntent, planSteps } from './orchestrator/index.js';
import { loadAgent, listAgents, loadAgentConfig, assembleSystemPrompt, getActiveTools, AGENTS_DIR } from './agent-runtime/index.js';
import { createTask as createTaskRecord, createStep } from './state-service/index.js';
import { runAgentLoop, DEFAULT_LOOP_CONFIG } from './agent-loop/index.js';
import { runToolPipeline, toAnthropicTools } from './tool-service/index.js';

// ── 启动时确保默认 Agent 存在 ──

function ensureDefaultAgent(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
  const defaultPath = join(AGENTS_DIR, 'assistant.json');
  if (!existsSync(defaultPath)) {
    const defaultConfig = {
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

  const event = normalizeEvent(body);
  if (!event) {
    return c.json({ code: 0, msg: 'duplicate or invalid event' });
  }

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

  return c.json({ code: 0, taskId: task.id, steps: stepDefs.length });
});

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
    { ...DEFAULT_LOOP_CONFIG, maxTurns: 10, tokenBudget: 20_000 },
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

// ── 工具列表 ──
app.get('/api/tools', (c) => {
  const tools = toAnthropicTools();
  return c.json({ count: tools.length, tools: tools.map(t => t.name) });
});

// ── 启动 ──
const port = Number(process.env['PORT']) || 3000;
console.log(`Jarvis Team server starting on port ${port}...`);
console.log(`  Agents: ${listAgents().join(', ')}`);
console.log(`  ANTHROPIC_API_KEY: ${process.env['ANTHROPIC_API_KEY'] ? 'set ✓' : 'not set (demo mode)'}`);

serve({ fetch: app.fetch, port });
