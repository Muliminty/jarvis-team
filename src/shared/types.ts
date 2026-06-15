// 任务状态机 — 对应技术架构 5.1 节
export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'done'
  | 'failed';

// 步骤类型
export type StepType = 'plan' | 'research' | 'execute' | 'review' | 'report';

// 步骤状态
export type StepStatus = 'pending' | 'running' | 'done' | 'blocked';

// Bot 发言状态机 — 对应技术架构 5.3 节
export type SpeakState = 'silent' | 'eligible' | 'approved_to_speak' | 'reported' | 'cooldown';

// 允许发言的四类事件 — 对应飞书落地 3.3 节
export type SpeakEventType = 'blocked' | 'result_ready' | 'risk_detected' | 'approval_needed';

// 前端/后台可见性
export type Visibility = 'frontstage' | 'backstage';

// Agent 角色标识
export type AgentKey = 'secretary' | 'pm' | 'qa-risk' | 'research' | 'worker' | 'orchestrator';

// 任务类型
export type TaskType = 'ask' | 'summarize' | 'project' | 'report' | 'execute';

// 协作模式 — 对应技术架构 1.3 节
export type CoordinationMode = 'single-agent' | 'parent-child' | 'light-swarm';

// 审批类型
export type ApprovalType = 'send' | 'write' | 'schedule' | 'external_call';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

// 记忆类型
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
