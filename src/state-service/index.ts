// 状态服务 — 对应技术架构 2.5 节
// 职责：存储任务、消息、角色输出、审批状态、会话上下文，
// 为 Agent 协作提供统一事实源 (single source of truth)
//
// 设计思路：所有 Agent 状态写入必须经过 state-service，不能各自直接写 DB。
// 这样保证了多 Agent 协作时的数据一致性，也方便审计和回放。

import type {
  TaskStatus,
  TaskType,
  StepType,
  StepStatus,
  AgentKey,
  ApprovalType,
  ApprovalStatus,
  MemoryType,
  CoordinationMode,
} from '../shared/types.js';

// ---- 数据模型（Phase 1 内存版，后续替换为 Drizzle ORM + PostgreSQL） ----

export interface Session {
  id: string;
  channelType: 'group' | 'p2p';
  chatId: string;
  initiatorOpenId: string;
  status: 'active' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  id: string;
  sessionId: string;
  title: string;
  taskType: TaskType;
  status: TaskStatus;
  ownerAgent: AgentKey;
  coordinationMode: CoordinationMode;
  priority: 'high' | 'medium' | 'low';
  inputPayload: unknown;
  resultPayload: unknown | null;
  createdBy: string;
  // 保险丝追踪
  turnCount: number;
  tokenUsed: number;
  lastApprovalAt: Date | null;
  lastActivityAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskStep {
  id: string;
  taskId: string;
  stepType: StepType;
  assignedAgent: AgentKey;
  status: StepStatus;
  input: unknown;
  output: unknown;
  dependsOn: string[];
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface Message {
  id: string;
  taskId: string;
  source: 'feishu' | 'system' | 'agent';
  speaker: string;
  messageType: 'text' | 'card' | 'event';
  content: unknown;
  feishuMessageId: string | null;
  createdAt: Date;
}

export interface Approval {
  id: string;
  taskId: string;
  approvalType: ApprovalType;
  status: ApprovalStatus;
  requestedByAgent: AgentKey;
  approverOpenId: string;
  contextPayload: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface Memory {
  id: string;
  memoryType: MemoryType;
  scope: 'global' | 'team' | 'project' | 'user';
  title: string;
  summary: string;
  content: string;
  sourceTaskId: string | null;
  expiresAt: Date | null;
  updatedAt: Date;
}

// ---- 内存存储（Phase 1 原型，后续替换为 PostgreSQL） ----

const sessions = new Map<string, Session>();
const tasks = new Map<string, Task>();
const steps = new Map<string, TaskStep>();
const messages = new Map<string, Message>();
const approvals = new Map<string, Approval>();
const memories = new Map<string, Memory>();

function id(): string {
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Session
export function createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Session {
  const session: Session = { ...data, id: id(), createdAt: new Date(), updatedAt: new Date() };
  sessions.set(session.id, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

// Task
export function createTask(data: Omit<Task, 'id' | 'turnCount' | 'tokenUsed' | 'lastApprovalAt' | 'lastActivityAt' | 'createdAt' | 'updatedAt'>): Task {
  const task: Task = {
    ...data,
    id: id(),
    turnCount: 0,
    tokenUsed: 0,
    lastApprovalAt: null,
    lastActivityAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  tasks.set(task.id, task);
  return task;
}

export function getTask(taskId: string): Task | undefined {
  return tasks.get(taskId);
}

export function updateTaskStatus(taskId: string, status: TaskStatus): Task | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  task.status = status;
  task.updatedAt = new Date();
  task.lastActivityAt = new Date();
  return task;
}

// TaskStep
export function createStep(data: Omit<TaskStep, 'id' | 'status' | 'startedAt' | 'finishedAt'>): TaskStep {
  const step: TaskStep = {
    ...data,
    id: id(),
    status: 'pending',
    startedAt: null,
    finishedAt: null,
  };
  steps.set(step.id, step);
  return step;
}

export function getStepsByTask(taskId: string): TaskStep[] {
  return [...steps.values()].filter(s => s.taskId === taskId);
}

// Message
export function createMessage(data: Omit<Message, 'id' | 'createdAt'>): Message {
  const msg: Message = { ...data, id: id(), createdAt: new Date() };
  messages.set(msg.id, msg);
  return msg;
}

export function getMessagesByTask(taskId: string): Message[] {
  return [...messages.values()]
    .filter(m => m.taskId === taskId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// Approval
export function createApproval(data: Omit<Approval, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): Approval {
  const approval: Approval = {
    ...data,
    id: id(),
    status: 'pending',
    createdAt: new Date(),
    resolvedAt: null,
  };
  approvals.set(approval.id, approval);
  return approval;
}

export function resolveApproval(approvalId: string, approved: boolean): Approval | undefined {
  const approval = approvals.get(approvalId);
  if (!approval) return undefined;
  approval.status = approved ? 'approved' : 'rejected';
  approval.resolvedAt = new Date();
  return approval;
}

// Memory
export function createMemory(data: Omit<Memory, 'id' | 'updatedAt'>): Memory {
  const memory: Memory = { ...data, id: id(), updatedAt: new Date() };
  memories.set(memory.id, memory);
  return memory;
}

export function getMemoriesByScope(scope: string): Memory[] {
  return [...memories.values()].filter(m => m.scope === scope);
}
