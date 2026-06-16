// 飞书事件网关 — 对应技术架构 2.1 节
// 职责：签名校验、幂等去重、消息标准化，把飞书原始事件转成内部 InternalEvent
//
// 踩坑提醒：飞书事件投递不保证 exactly-once，去重必须基于 event_id 做幂等，
// 不能仅靠消息顺序。消息重放时可能乱序到达。

import type { InternalEvent } from '../shared/events.js';

export interface GatewayConfig {
  verificationToken: string;
  webhookPath: string;
}

// 飞书事件回调的原始 payload（简化版，只保留必要字段）
interface FeishuEventPayload {
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token?: string;
  };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: {
      message_id: string;
      chat_id: string;
      chat_type: 'group' | 'p2p';
      content: string;
    };
  };
  challenge?: string;
}

// 已处理事件 ID 集合（生产环境应替换为 Redis/DB 持久化）
const processedEventIds = new Set<string>();
// 去重窗口内最大缓存事件数
const MAX_DEDUP_SIZE = 10_000;

function registerEventId(eventId: string): boolean {
  if (processedEventIds.has(eventId)) return false;
  processedEventIds.add(eventId);
  // 防止内存泄漏：超过阈值清空旧记录
  if (processedEventIds.size > MAX_DEDUP_SIZE) {
    const toDelete = processedEventIds.size - MAX_DEDUP_SIZE / 2;
    let count = 0;
    for (const id of processedEventIds) {
      if (count >= toDelete) break;
      processedEventIds.delete(id);
      count++;
    }
  }
  return true;
}

export function normalizeEvent(raw: FeishuEventPayload): InternalEvent | null {
  const eventId = raw.header?.event_id;
  if (!eventId) return null;

  // 幂等去重
  if (!registerEventId(eventId)) return null;

  const senderId = raw.event?.sender?.sender_id?.open_id ?? 'unknown';
  const message = raw.event?.message;

  return {
    id: eventId,
    sessionId: message?.chat_id ?? 'unknown',
    chatId: message?.chat_id ?? 'unknown',
    chatType: message?.chat_type ?? 'p2p',
    initiatorOpenId: senderId,
    eventType: mapFeishuEventType(raw.header?.event_type ?? ''),
    payload: (raw.event ?? {}) as Record<string, unknown>,
    feishuMessageId: message?.message_id,
    timestamp: new Date(raw.header?.create_time ?? Date.now()),
  };
}

function mapFeishuEventType(feishuType: string): InternalEvent['eventType'] {
  switch (feishuType) {
    case 'im.message.receive_v1':
      return 'message';
    case 'im.message.reaction.created_v1':
      return 'card_action';
    case 'im.chat.member.bot.added_v1':
      return 'bot_mentioned';
    default:
      return 'message';
  }
}
