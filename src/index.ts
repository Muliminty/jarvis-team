// 飞书多Agent协作系统 主入口
// 按技术架构 9 节实施顺序：
// Phase 1: gateway + orchestrator + state + secretary
// Phase 2: pm-agent + qa-risk-agent
// Phase 3: tool policy + prompt pipe + memory + 保险丝
// Phase 4: Docs + 多维表格 + 卡片审批

import { Hono } from 'hono';
import { normalizeEvent } from './gateway/index.js';
import { classifyIntent, planSteps, checkFuses } from './orchestrator/index.js';
import { AGENT_PROFILES, assembleSystemPrompt, getActiveTools } from './agent-runtime/index.js';
import { createTask as createTaskRecord, createStep } from './state-service/index.js';

const app = new Hono();

// 飞书事件回调端点
app.post('/feishu/event', async (c) => {
  const body = await c.req.json();

  // 1. Gateway: 标准化 & 去重
  const event = normalizeEvent(body);
  if (!event) {
    return c.json({ code: 0, msg: 'duplicate or invalid event' });
  }

  // 2. Orchestrator: 意图分类
  const intent = classifyIntent(event);
  console.log('[orchestrator] intent:', intent);

  // 3. 创建任务
  const task = createTaskRecord({
    sessionId: event.sessionId,
    title: `任务-${event.id}`,
    taskType: intent.taskType,
    status: 'pending',
    ownerAgent: 'orchestrator',
    coordinationMode: intent.coordinationMode,
    priority: 'medium',
    inputPayload: event.payload,
    resultPayload: null,
    createdBy: event.initiatorOpenId,
  });

  // 4. 拆解步骤
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

  return c.json({ code: 0, taskId: task.id });
});

// 健康检查
app.get('/health', (c) => {
  return c.json({ status: 'ok', profiles: Object.keys(AGENT_PROFILES) });
});

// 获取 Agent Profile
app.get('/agents/:key', (c) => {
  const key = c.req.param('key') as keyof typeof AGENT_PROFILES;
  const profile = AGENT_PROFILES[key];
  if (!profile) return c.json({ error: 'not found' }, 404);
  return c.json(profile);
});

const port = Number(process.env['PORT']) || 3000;
console.log(`Jarvis Team server starting on port ${port}...`);

export default { port, fetch: app.fetch };
