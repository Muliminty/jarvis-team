# API 文档

> 状态: draft · 代码: 部分实现
> 基础 URL: `http://localhost:3000`（开发环境）

---

## 健康检查

```
GET /health
```

**响应**：
```json
{
  "status": "ok",
  "profiles": ["secretary", "reviewer", "orchestrator"],
  "anthropicKeySet": true
}
```

---

## 工具列表

```
GET /api/tools
```

**响应**：
```json
{
  "count": 7,
  "tools": ["send_group_message", "send_card", "create_doc", "search_docs", "fetch_memory_context", "tool_search", "request_human_approval"]
}
```

---

## Agent 信息

```
GET /agents/:key
```

**参数**：`key` — Agent 标识（`secretary`、`reviewer`、`orchestrator`）

**响应**：
```json
{
  "key": "secretary",
  "displayName": "秘书",
  "visibility": "frontstage",
  "tools": ["send_group_message", "send_card", "fetch_memory_context"]
}
```

---

## Chat 对话

```
POST /api/chat
```

**请求体**：
```json
{
  "message": "你好，帮我搜索项目文档",
  "agent": "secretary"
}
```

**响应**：
```json
{
  "messages": [
    { "role": "user", "content": "你好，帮我搜索项目文档" },
    { "role": "assistant", "content": "好的，我来搜索...搜索结果显示..." }
  ],
  "exitReason": {
    "type": "completed",
    "message": "搜索完成..."
  },
  "usage": {
    "turnCount": 3,
    "totalOutputTokens": 1250,
    "totalInputTokens": 4800
  }
}
```

**退出原因类型**：

| type | 含义 | 可恢复 |
|------|------|--------|
| `completed` | 正常完成 | - |
| `max_turns` | 超过最大轮次 | 重新发起 |
| `aborted_streaming` | 用户中断流式输出 | 续问 |
| `aborted_tools` | API 认证失败 / 致命错误 | 修配置后重试 |
| `loop_detected` | 死循环熔断 | 换个问法 |
| `token_budget_exceeded` | Token 预算耗尽 | 简化任务 |
| `truncation_give_up` | 连续 3 次截断恢复失败 | 拆分任务 |

---

## 飞书事件回调

```
POST /feishu/event
```

当前单 Bot 模式入口。多 Bot 架构迁移后改为：

```
POST /feishu/bot/:agentId
```

**请求体**：飞书标准事件回调格式

**响应**：
```json
{
  "code": 0,
  "taskId": "id_xxx",
  "steps": 3
}
```

---

## Agent 创建（聊天命令）

群里 @秘书 发送：

```
@秘书 创建一个新 Bot，叫"数据观察员"，每天早上 9 点汇报数据
```

系统返回：

```
✅ 已创建 Agent: 数据观察员 (data-watcher)
请去飞书开发者后台注册 Bot，把 App ID 和 App Secret 发给我。
```

绑定凭证：

```
@秘书 App ID: cli_xxx  App Secret: xxx
```

系统返回：

```
✅ 已绑定！数据观察员现在可以接收消息了。
```
