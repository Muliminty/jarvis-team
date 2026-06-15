// 飞书多Agent协作系统 主入口
// 按技术架构 9 节实施顺序：
// Phase 1: gateway + orchestrator + state + secretary
// Phase 2: pm-agent + qa-risk-agent
// Phase 3: tool policy + prompt pipe + memory + 保险丝
// Phase 4: Docs + 多维表格 + 卡片审批

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { normalizeEvent } from './gateway/index.js';
import { classifyIntent, planSteps } from './orchestrator/index.js';
import { AGENT_PROFILES, assembleSystemPrompt, getActiveTools } from './agent-runtime/index.js';
import { createTask as createTaskRecord, createStep } from './state-service/index.js';
import { runAgentLoop, DEFAULT_LOOP_CONFIG } from './agent-loop/index.js';
import { runToolPipeline, toAnthropicTools } from './tool-service/index.js';

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
    ownerAgent: 'orchestrator',
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

// ── Chat Demo 端点 ──
// 直接与 Agent 对话（无需飞书事件）
app.post('/api/chat', async (c) => {
  const body = await c.req.json();
  const userMessage: string = body.message ?? '';
  const agentRole: string = body.agent ?? 'secretary';

  if (!userMessage) {
    return c.json({ error: 'message is required' }, 400);
  }

  // 1. 选择 Agent Profile
  const profile = AGENT_PROFILES[agentRole as keyof typeof AGENT_PROFILES];
  if (!profile) {
    return c.json({ error: `unknown agent: ${agentRole}` }, 400);
  }

  // 2. 获取可用工具（reporting stage）
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
  const messages = [
    { role: 'user' as const, content: userMessage },
  ];

  // 6. 运行 Agent Loop
  const result = await runAgentLoop(
    systemPrompt,
    messages as any,
    tools,
    async (name, params) => {
      const output = await runToolPipeline(name, params, {
        agentKey: agentRole,
        taskId: 'demo',
      });
      return output;
    },
    {
      ...DEFAULT_LOOP_CONFIG,
      // 开发环境使用较小预算
      maxTurns: 10,
      tokenBudget: 20_000,
    },
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
    profiles: Object.keys(AGENT_PROFILES),
    anthropicKeySet: !!process.env['ANTHROPIC_API_KEY'],
  });
});

// ── Agent Profile 查询 ──
app.get('/agents/:key', (c) => {
  const key = c.req.param('key') as keyof typeof AGENT_PROFILES;
  const profile = AGENT_PROFILES[key];
  if (!profile) return c.json({ error: 'not found' }, 404);
  return c.json({
    key: profile.key,
    displayName: profile.displayName,
    visibility: profile.visibility,
    tools: profile.toolScope.coreTools,
  });
});

// ── 工具列表查询 ──
app.get('/api/tools', (c) => {
  const tools = toAnthropicTools();
  return c.json({ count: tools.length, tools: tools.map(t => t.name) });
});

const port = Number(process.env['PORT']) || 3000;
console.log(`Jarvis Team server starting on port ${port}...`);
console.log(`  Profiles: ${Object.keys(AGENT_PROFILES).join(', ')}`);
console.log(`  ANTHROPIC_API_KEY: ${process.env['ANTHROPIC_API_KEY'] ? 'set ✓' : 'not set (demo mode)'}`);

serve({ fetch: app.fetch, port });
