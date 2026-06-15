// 工具服务 — 对应技术架构 2.4 节
// 职责：封装飞书 Open API，提供统一工具接口给 Agent 调用
//
// 踩坑提醒：飞书 API 有频率限制（群消息 5QPS/群，文档写入 10QPS/租户），
// 工具层需要内置 rate limiter 和重试机制，否则高峰期容易触发 429。

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // 是否需要二次审批
  requiresApproval: boolean;
  // 风险等级
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ToolCallRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  taskId: string;
  agentKey: string;
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// 工具注册表 — 对应技术架构 2.4 节建议工具清单
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  send_group_message: {
    name: 'send_group_message',
    description: '向飞书群发送消息',
    parameters: { chat_id: 'string', content: 'string', msg_type: 'text | card' },
    requiresApproval: false,
    riskLevel: 'medium',
  },
  send_card: {
    name: 'send_card',
    description: '向飞书群发送交互卡片',
    parameters: { chat_id: 'string', card: 'json' },
    requiresApproval: true,
    riskLevel: 'high',
  },
  create_doc: {
    name: 'create_doc',
    description: '创建飞书文档',
    parameters: { title: 'string', content: 'string', folder_token: 'string?' },
    requiresApproval: true,
    riskLevel: 'high',
  },
  append_doc_block: {
    name: 'append_doc_block',
    description: '向飞书文档追加内容块',
    parameters: { doc_token: 'string', blocks: 'json[]' },
    requiresApproval: false,
    riskLevel: 'medium',
  },
  update_bitable_record: {
    name: 'update_bitable_record',
    description: '更新多维表格记录',
    parameters: { table_id: 'string', records: 'json[]' },
    requiresApproval: true,
    riskLevel: 'high',
  },
  create_calendar_event: {
    name: 'create_calendar_event',
    description: '创建日历事件',
    parameters: { summary: 'string', start_time: 'string', end_time: 'string' },
    requiresApproval: true,
    riskLevel: 'high',
  },
  search_docs: {
    name: 'search_docs',
    description: '搜索飞书文档与知识库',
    parameters: { query: 'string', limit: 'number?' },
    requiresApproval: false,
    riskLevel: 'low',
  },
  fetch_memory_context: {
    name: 'fetch_memory_context',
    description: '获取用户偏好与项目记忆',
    parameters: { scope: 'string', keys: 'string[]?' },
    requiresApproval: false,
    riskLevel: 'low',
  },
  tool_search: {
    name: 'tool_search',
    description: '动态发现可用工具（延迟发现机制）',
    parameters: { intent: 'string', stage: 'string' },
    requiresApproval: false,
    riskLevel: 'low',
  },
  request_human_approval: {
    name: 'request_human_approval',
    description: '请求人类审批',
    parameters: { task_id: 'string', action: 'string', context: 'string' },
    requiresApproval: true,
    riskLevel: 'high',
  },
};

// Phase 1 stub：后续接入真实飞书 API
export async function executeTool(request: ToolCallRequest): Promise<ToolCallResult> {
  const tool = TOOL_REGISTRY[request.toolName];
  if (!tool) {
    return { success: false, error: `未知工具: ${request.toolName}` };
  }

  // 审批检查：高风险操作需确认审批已通过
  if (tool.requiresApproval) {
    // TODO: 检查 approvals 表确认状态
  }

  // TODO: 实际调用飞书 Open API
  return { success: true, data: { message: `stub: ${request.toolName} called` } };
}
