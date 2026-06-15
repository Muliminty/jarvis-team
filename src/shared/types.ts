// 任务状态机 — v1 Plan 对齐 (CEO Review + Codex 确认)
// 设计思路：与 Agent Loop 的 think→act→observe 节奏匹配，
// 每个状态对应 Loop 中的一个阶段，不是 workflow 的静态步骤
export type TaskStatus =
  | 'new'            // 新创建，等待 Orchestrator 分配
  | 'clarifying'     // 需要更多信息，可能触发与用户的多轮交互
  | 'planned'        // Secretary 已输出执行计划
  | 'drafted'        // Secretary 完成初稿，等待 Reviewer 审查
  | 'reviewed'       // Reviewer 审查通过
  | 'approved'       // Orchestrator 确认输出，发送到飞书群
  | 'failed';        // 任意 Agent 异常或超时

// v1 仅支持 ask 类型，其余为 v2 占位
export type TaskType = 'ask' | 'summarize' | 'project' | 'report' | 'execute';

// 协作模式 — v1 仅 single-agent，parent-child/swarm 留 Phase 2+
export type CoordinationMode = 'single-agent' | 'parent-child' | 'light-swarm';

// Agent 角色 — 可动态创建，不再限制内置角色名
export type AgentKey = string;

// 飞书回复可见性
export type Visibility = 'frontstage' | 'backstage';

// Bot 发言状态机
export type SpeakState = 'silent' | 'eligible' | 'approved_to_speak' | 'reported' | 'cooldown';

// 允许发言的四类事件
export type SpeakEventType = 'blocked' | 'result_ready' | 'risk_detected' | 'approval_needed';

// 步骤类型 — 对应 orchestrator planSteps 输出
export type StepType = 'plan' | 'research' | 'execute' | 'review' | 'report';

// 步骤状态
export type StepStatus = 'pending' | 'running' | 'done' | 'blocked';

// 审批类型
export type ApprovalType = 'send' | 'write' | 'schedule' | 'external_call';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

// 记忆类型 — 供 Phase 4 Memory 系统使用
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
