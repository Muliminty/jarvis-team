// 内部标准化事件 — 飞书原始事件经 gateway 转换后统一为此格式
export interface InternalEvent {
  id: string;
  sessionId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  initiatorOpenId: string;
  eventType: 'message' | 'card_action' | 'bot_mentioned' | 'doc_updated';
  payload: Record<string, unknown>;
  feishuMessageId?: string;
  timestamp: Date;
}

// Agent 间 mailbox 事件 — 对应技术架构 3.8 节
export interface MailboxEvent {
  id: string;
  taskId: string;
  fromAgent: string;
  toAgent: string;
  eventType: 'request' | 'result' | 'risk' | 'approval' | 'shutdown';
  payload: unknown;
  status: 'pending' | 'consumed' | 'failed';
  createdAt: Date;
}
