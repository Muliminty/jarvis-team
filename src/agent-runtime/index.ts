// Agent 运行时 — 对应技术架构 2.3 节
// 职责：加载 Agent 配置、组装 System Prompt、管理工具可见性
//
// 设计思路：Agent 配置存储在 agents/*.json 文件中，支持动态创建和修改。
// 没有内置角色——所有 Agent 平等，包括默认的 assistant。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Visibility, SpeakEventType } from '../shared/types.js';

// ──────────────────────────────────────────
// Agent 配置文件目录
// ──────────────────────────────────────────

export const AGENTS_DIR = join(process.cwd(), 'agents');

// ──────────────────────────────────────────
// JSON 配置格式（用户友好，文件存储用）
// ──────────────────────────────────────────

export interface AgentConfig {
  id: string;
  displayName: string;
  description?: string;
  feishuBot?: {
    appId: string;
    appSecret: string;
    verificationToken: string;
  };
  persona: {
    corePrompt: string;
    voiceStyle?: string;
  };
  toolScope: {
    coreTools: string[];
    stageTools?: Record<string, string[]>;
    approvalRequired?: string[];
  };
  speakRules: {
    canInitiate: boolean;
    triggers: string[];
    cooldownMs: number;
  };
}

// ──────────────────────────────────────────
// 运行时 Agent Profile（与工具环交互用）
// ──────────────────────────────────────────

export interface AgentProfile {
  key: string;
  displayName: string;
  voiceStyle: string;
  visibility: Visibility;
  speakRules: SpeakRules;
  toolScope: ToolPolicy;
  promptModules: PromptModule[];
}

export interface SpeakRules {
  canInitiate: boolean;
  triggers: SpeakEventType[];
  cooldownMs: number;
  canMentionUser: boolean;
}

export interface ToolPolicy {
  coreTools: string[];
  stageTools: Record<string, string[]>;
  discoverableTools: string[];
  approvalRequired: string[];
}

export interface PromptModule {
  name: string;
  priority: number;
  condition?: (ctx: AgentContext) => boolean;
  content: string;
}

export interface AgentContext {
  taskType: string;
  currentStep: string;
  sessionSummary?: string;
  relevantMemories?: string[];
  activeTools: string[];
}

// ──────────────────────────────────────────
// 加载 Agent
// ──────────────────────────────────────────

/** 加载一个 Agent 的配置文件 */
export function loadAgent(id: string): AgentProfile | null {
  const path = join(AGENTS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const config: AgentConfig = JSON.parse(raw);
    return configToProfile(config);
  } catch {
    return null;
  }
}

/** 加载 Agent 的原始 JSON 配置（供管理工具读写） */
export function loadAgentConfig(id: string): AgentConfig | null {
  const path = join(AGENTS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** 列出所有已注册的 Agent ID */
export function listAgents(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

/** 将用户友好的 JSON 配置转为运行时 AgentProfile */
function configToProfile(config: AgentConfig): AgentProfile {
  return {
    key: config.id,
    displayName: config.displayName,
    voiceStyle: config.persona.voiceStyle ?? '默认',
    visibility: 'frontstage',
    speakRules: {
      canInitiate: config.speakRules.canInitiate,
      triggers: config.speakRules.triggers as SpeakEventType[],
      cooldownMs: config.speakRules.cooldownMs,
      canMentionUser: true,
    },
    toolScope: {
      coreTools: config.toolScope.coreTools,
      stageTools: config.toolScope.stageTools ?? {},
      discoverableTools: [],
      approvalRequired: config.toolScope.approvalRequired ?? [],
    },
    promptModules: [
      {
        name: 'core',
        priority: 0,
        content: config.persona.corePrompt,
      },
    ],
  };
}

// ──────────────────────────────────────────
// System Prompt 组装
// ──────────────────────────────────────────

export function assembleSystemPrompt(
  profile: AgentProfile,
  ctx: AgentContext,
): string {
  const modules = profile.promptModules
    .filter(m => !m.condition || m.condition(ctx))
    .sort((a, b) => a.priority - b.priority);

  const parts: string[] = [];

  parts.push(modules.map(m => m.content).join('\n'));
  parts.push(`语气：${profile.voiceStyle}`);
  parts.push(`可用工具：${ctx.activeTools.join(', ')}`);

  const rules = profile.speakRules;
  parts.push(`发言规则：${rules.canInitiate ? '可主动发言' : '仅在触发条件下发言'}。触发条件：${rules.triggers.join(', ') || '无主动触发'}`);

  if (ctx.sessionSummary) parts.push(`会话摘要：${ctx.sessionSummary}`);
  if (ctx.relevantMemories?.length) parts.push(`相关记忆：${ctx.relevantMemories.join('；')}`);

  return parts.join('\n\n');
}

export function getActiveTools(
  profile: AgentProfile,
  stage: string,
): string[] {
  const stageTools = profile.toolScope.stageTools[stage] ?? [];
  return [...new Set([...profile.toolScope.coreTools, ...stageTools])];
}
