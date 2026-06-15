// Agent 运行时 — 对应技术架构 2.3 节
// 职责：承载各角色 Prompt、工具权限、输出协议，
// 通过 Prompt Pipe 组装角色上下文，按 Tool Policy 动态暴露工具
//
// 设计思路：每个 Agent 角色不是独立的微服务，而是"角色化 Prompt + 工具权限"的组合。
// Prompt Pipe 把角色 Prompt 拆成可组合的模块，避免长字符串硬编码，也方便
// 后续按上下文动态裁剪。

import type { AgentKey, Visibility, SpeakState, SpeakEventType } from '../shared/types.js';

// Agent 角色定义 — 对应飞书落地 2.x 节各 Bot 人设
export interface AgentProfile {
  key: AgentKey;
  displayName: string;
  voiceStyle: string;
  visibility: Visibility;
  speakRules: SpeakRules;
  toolScope: ToolPolicy;
  // 角色 System Prompt 由多个 Pipe 模块拼接
  promptModules: PromptModule[];
}

export interface SpeakRules {
  // 该角色是否可主动发言
  canInitiate: boolean;
  // 触发发言的事件类型
  triggers: SpeakEventType[];
  // 同一任务冷却期 (ms)
  cooldownMs: number;
  // 是否可直接 @ 用户
  canMentionUser: boolean;
}

// Tool Policy — 对应技术架构 2.4.1 节
// 每个角色不直接拥有全部飞书能力，而是按阶段动态暴露
export interface ToolPolicy {
  // 核心常驻工具（始终可见）
  coreTools: string[];
  // 按任务阶段可见的工具
  stageTools: Record<string, string[]>;
  // 通过 tool_search 延迟发现的工具
  discoverableTools: string[];
  // 需要二次审批的工具
  approvalRequired: string[];
}

// Prompt Pipe 模块 — 可组合的 Prompt 片段
export interface PromptModule {
  name: string;
  // 优先级：数字越小越靠前
  priority: number;
  // 该模块在什么条件下注入
  condition?: (ctx: AgentContext) => boolean;
  // Prompt 内容
  content: string;
}

// Agent 执行上下文
export interface AgentContext {
  taskType: string;
  currentStep: string;
  sessionSummary?: string;
  relevantMemories?: string[];
  activeTools: string[];
}

// 预定义角色
export const AGENT_PROFILES: Record<AgentKey, AgentProfile> = {
  secretary: {
    key: 'secretary',
    displayName: '秘书',
    voiceStyle: '稳定、简洁、像执行秘书。不输出长推理，优先给结论和下一步。',
    visibility: 'frontstage',
    speakRules: {
      canInitiate: true,
      triggers: ['result_ready', 'approval_needed', 'blocked'],
      cooldownMs: 10_000,
      canMentionUser: true,
    },
    toolScope: {
      coreTools: ['send_group_message', 'send_card', 'fetch_memory_context'],
      stageTools: {
        reporting: ['search_docs', 'tool_search'],
      },
      discoverableTools: ['create_doc', 'update_bitable_record'],
      approvalRequired: ['create_doc', 'send_card'],
    },
    promptModules: [
      {
        name: 'secretary-core',
        priority: 0,
        content: '你是执行秘书，负责接需求、做总结、发纪要、发提醒、向用户索要决策。',
      },
    ],
  },
  pm: {
    key: 'pm',
    displayName: 'PM',
    voiceStyle: '结构化、明确、带流程感。',
    visibility: 'frontstage',
    speakRules: {
      canInitiate: false,
      triggers: ['blocked'],
      cooldownMs: 30_000,
      canMentionUser: true,
    },
    toolScope: {
      coreTools: ['search_docs', 'fetch_memory_context'],
      stageTools: {
        planning: ['tool_search'],
        review: ['tool_search'],
      },
      discoverableTools: ['tool_search'],
      approvalRequired: [],
    },
    promptModules: [
      {
        name: 'pm-core',
        priority: 0,
        content: '你是项目经理，负责把模糊需求拆成结构化任务，标记依赖和优先级，发现范围蔓延。',
      },
    ],
  },
  'qa-risk': {
    key: 'qa-risk',
    displayName: '风控',
    voiceStyle: '克制、直接、不频繁发言。',
    visibility: 'frontstage',
    speakRules: {
      canInitiate: false,
      triggers: ['risk_detected', 'approval_needed'],
      cooldownMs: 60_000,
      canMentionUser: true,
    },
    toolScope: {
      coreTools: ['search_docs', 'fetch_memory_context'],
      stageTools: {
        review: ['tool_search'],
      },
      discoverableTools: [],
      approvalRequired: [],
    },
    promptModules: [
      {
        name: 'qa-core',
        priority: 0,
        content: '你是风控/复核官，负责发现风险、挑出冲突、阻止越权、在低置信度时要求人工确认。默认沉默，仅在风险事件下发言。',
      },
    ],
  },
  research: {
    key: 'research',
    displayName: '调研',
    voiceStyle: '后台角色，不前台发言。',
    visibility: 'backstage',
    speakRules: {
      canInitiate: false,
      triggers: [],
      cooldownMs: 0,
      canMentionUser: false,
    },
    toolScope: {
      coreTools: ['search_docs', 'tool_search', 'fetch_memory_context'],
      stageTools: {},
      discoverableTools: ['tool_search'],
      approvalRequired: [],
    },
    promptModules: [
      {
        name: 'research-core',
        priority: 0,
        content: '你是调研 Agent，负责搜索文档、知识库、历史项目和外部资料。将结果以结构化摘要返回。',
      },
    ],
  },
  worker: {
    key: 'worker',
    displayName: '执行',
    voiceStyle: '后台角色，不前台发言。',
    visibility: 'backstage',
    speakRules: {
      canInitiate: false,
      triggers: [],
      cooldownMs: 0,
      canMentionUser: false,
    },
    toolScope: {
      coreTools: ['create_doc', 'append_doc_block', 'update_bitable_record', 'create_calendar_event'],
      stageTools: {},
      discoverableTools: ['tool_search'],
      approvalRequired: ['create_doc', 'update_bitable_record', 'create_calendar_event'],
    },
    promptModules: [
      {
        name: 'worker-core',
        priority: 0,
        content: '你是执行 Agent，负责写文档、写表格、整理草稿、生成初版输出。执行写操作前必须经过审批。',
      },
    ],
  },
  orchestrator: {
    key: 'orchestrator',
    displayName: '调度器',
    voiceStyle: '纯后台，不与用户交互。',
    visibility: 'backstage',
    speakRules: {
      canInitiate: false,
      triggers: [],
      cooldownMs: 0,
      canMentionUser: false,
    },
    toolScope: {
      coreTools: [],
      stageTools: {},
      discoverableTools: [],
      approvalRequired: [],
    },
    promptModules: [
      {
        name: 'orch-core',
        priority: 0,
        content: '你是调度器，负责意图识别、任务拆解、Agent 路由、状态管理。不直接出现在群聊中。',
      },
    ],
  },
};

// 组装角色 System Prompt — Prompt Pipe 核心逻辑
export function assembleSystemPrompt(
  profile: AgentProfile,
  ctx: AgentContext,
): string {
  const modules = profile.promptModules
    .filter(m => !m.condition || m.condition(ctx))
    .sort((a, b) => a.priority - b.priority);

  const parts: string[] = [];

  // 1. 角色定义
  parts.push(modules.map(m => m.content).join('\n'));

  // 2. 语气设定
  parts.push(`语气：${profile.voiceStyle}`);

  // 3. 当前可用工具
  parts.push(`可用工具：${ctx.activeTools.join(', ')}`);

  // 4. 发言规则
  const rules = profile.speakRules;
  parts.push(`发言规则：${rules.canInitiate ? '可主动发言' : '仅在触发条件下发言'}。触发条件：${rules.triggers.join(', ') || '无主动触发'}`);

  // 5. 当前上下文
  if (ctx.sessionSummary) {
    parts.push(`会话摘要：${ctx.sessionSummary}`);
  }
  if (ctx.relevantMemories?.length) {
    parts.push(`相关记忆：${ctx.relevantMemories.join('；')}`);
  }

  return parts.join('\n\n');
}

// 获取当前阶段可见工具列表
export function getActiveTools(
  profile: AgentProfile,
  stage: string,
): string[] {
  const stageTools = profile.toolScope.stageTools[stage] ?? [];
  return [...new Set([...profile.toolScope.coreTools, ...stageTools])];
}
