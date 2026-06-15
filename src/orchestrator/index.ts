// 编排服务 — 对应技术架构 2.2 节
// 职责：意图识别、任务规划、Agent 路由、执行控制、审批控制、保险丝、spawn 控制
//
// 设计思路：orchestrator 是多 Agent 协作的"总指挥"，不直接执行任务，
// 而是决定"谁来做什么、什么时候做、什么时候停"。所有 Agent 的输出和
// 状态变更都经过它，这是保证状态一致性的关键。

import type {
  TaskStatus,
  TaskType,
  CoordinationMode,
  AgentKey,
  StepType,
  StepStatus,
} from '../shared/types.js';
import type { InternalEvent } from '../shared/events.js';
import type { Task, TaskStep } from '../state-service/index.js';

// 保险丝配置 — 对应技术架构 5.4 节
export interface FuseConfig {
  maxTurnsPerTask: number;        // 单任务最大轮次
  maxTokensPerTask: number;       // 单任务最大 Token 预算
  maxSpawnFanout: number;         // 子 Agent 最大 fan-out 数
  sameResultLoopGuard: number;    // 同结果重复检测窗口
  duplicatePublicMessageGuardMs: number;  // 同群重复发言冷却
  approvalTimeoutMs: number;      // 审批等待超时
  agentIdleTimeoutMs: number;     // Agent 空闲超时
}

export const DEFAULT_FUSE_CONFIG: FuseConfig = {
  maxTurnsPerTask: 20,
  maxTokensPerTask: 200_000,
  maxSpawnFanout: 5,
  sameResultLoopGuard: 3,
  duplicatePublicMessageGuardMs: 30_000,
  approvalTimeoutMs: 300_000,    // 5 分钟
  agentIdleTimeoutMs: 600_000,   // 10 分钟
};

// 意图分类结果
export interface IntentClassification {
  taskType: TaskType;
  coordinationMode: CoordinationMode;
  confidence: number;  // 0-1
}

// 创建任务上下文
export interface CreateTaskContext {
  sessionId: string;
  initiatorOpenId: string;
  inputPayload: unknown;
  intent: IntentClassification;
}

export function classifyIntent(event: InternalEvent): IntentClassification {
  // Phase 1: 基于规则的简单意图分类，后续可替换为 LLM 分类
  const content = extractTextContent(event);
  const defaultResult: IntentClassification = {
    taskType: 'ask',
    coordinationMode: 'single-agent',
    confidence: 0.5,
  };

  if (!content) return defaultResult;

  // 项目创建类关键词
  if (/项目|方案|计划|拆解|整理成.*项目/.test(content)) {
    return { taskType: 'project', coordinationMode: 'parent-child', confidence: 0.8 };
  }
  // 总结类关键词
  if (/总结|纪要|汇总|日报|周报|整理.*会议/.test(content)) {
    return { taskType: 'summarize', coordinationMode: 'parent-child', confidence: 0.8 };
  }
  // 执行类关键词
  if (/写|创建|生成|发[布送]|同步|更新.*表格/.test(content)) {
    return { taskType: 'execute', coordinationMode: 'parent-child', confidence: 0.7 };
  }
  // 汇报类
  if (/汇报|进展|进度|状态/.test(content)) {
    return { taskType: 'report', coordinationMode: 'single-agent', confidence: 0.7 };
  }

  return defaultResult;
}

function extractTextContent(event: InternalEvent): string {
  const msg = event.payload as { content?: string; text?: string };
  return msg?.content ?? msg?.text ?? '';
}

// 将任务拆解为步骤 — PM Agent 的核心能力
// 当前为规则版，后续替换为 LLM 驱动
export function planSteps(taskType: TaskType): Omit<TaskStep, 'id' | 'taskId' | 'status' | 'input' | 'output' | 'startedAt' | 'finishedAt'>[] {
  // v1: 仅 3 个 Agent（secretary/reviewer/orchestrator），pm/research/worker/qa-risk 留 Phase 2
  switch (taskType) {
    case 'project':
      return [
        { stepType: 'plan', assignedAgent: 'secretary', dependsOn: [] },
        { stepType: 'execute', assignedAgent: 'secretary', dependsOn: ['step-0'] },
        { stepType: 'review', assignedAgent: 'reviewer', dependsOn: ['step-1'] },
        { stepType: 'report', assignedAgent: 'secretary', dependsOn: ['step-2'] },
      ];
    case 'summarize':
      return [
        { stepType: 'execute', assignedAgent: 'secretary', dependsOn: [] },
        { stepType: 'review', assignedAgent: 'reviewer', dependsOn: ['step-0'] },
        { stepType: 'report', assignedAgent: 'secretary', dependsOn: ['step-1'] },
      ];
    case 'execute':
      return [
        { stepType: 'execute', assignedAgent: 'secretary', dependsOn: [] },
        { stepType: 'review', assignedAgent: 'reviewer', dependsOn: ['step-0'] },
        { stepType: 'report', assignedAgent: 'secretary', dependsOn: ['step-1'] },
      ];
    default:
      return [
        { stepType: 'report', assignedAgent: 'secretary', dependsOn: [] },
      ];
  }
}

// 保险丝检查：检查当前任务是否触发熔断
export function checkFuses(
  task: Task,
  config: FuseConfig = DEFAULT_FUSE_CONFIG,
): { tripped: boolean; reason?: string } {
  const now = Date.now();

  // 轮次上限
  if (task.turnCount !== undefined && task.turnCount >= config.maxTurnsPerTask) {
    return { tripped: true, reason: `超过最大轮次 ${config.maxTurnsPerTask}` };
  }
  // Token 预算
  if (task.tokenUsed !== undefined && task.tokenUsed >= config.maxTokensPerTask) {
    return { tripped: true, reason: `超过 Token 预算 ${config.maxTokensPerTask}` };
  }
  // 审批超时：drafted 状态下等待 reviewer 审批
  if (task.status === 'drafted' && task.lastApprovalAt) {
    const elapsed = now - task.lastApprovalAt.getTime();
    if (elapsed > config.approvalTimeoutMs) {
      return { tripped: true, reason: '审批等待超时' };
    }
  }
  // Agent 空闲超时：正在执行的任务长时间无活动
  if ((task.status === 'planned' || task.status === 'clarifying') && task.lastActivityAt) {
    const elapsed = now - task.lastActivityAt.getTime();
    if (elapsed > config.agentIdleTimeoutMs) {
      return { tripped: true, reason: 'Agent 空闲超时' };
    }
  }

  return { tripped: false };
}

export function selectCoordinationMode(
  taskType: TaskType,
  complexity: 'simple' | 'medium' | 'complex',
): CoordinationMode {
  if (complexity === 'simple') return 'single-agent';
  if (complexity === 'medium') return 'parent-child';
  return 'parent-child'; // light-swarm 留给 Phase 2
}
