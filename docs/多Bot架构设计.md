# 多 Bot 架构设计：一个 Agent = 一个飞书 Bot

> 状态: approved · 代码: 未实现
> 前置条件：管理員在飞书开发者后台手动注册 N 个 Bot，每个获得 App ID + App Secret
> jarvis-team 负责把 Bot 凭证映射到 Agent Profile，运行时按 Bot 路由

---

## 一、整体架构

```
飞书群聊                          jarvis-team 服务器
┌──────────────┐               ┌─────────────────────────────────┐
│  Bot A: 秘书  │──webhook A──→│  /feishu/bot/secretary          │
│              │               │       ↓                         │
│  Bot B: 数据  │──webhook B──→│  加载 Agent Profile             │
│    观察员    │               │  (名称/人设/工具/权限)           │
│              │               │       ↓                         │
│  Bot C: 代码  │──webhook C──→│  Agent Loop                     │
│    审查员    │               │  (保险丝 + 流式 + 退出路径)      │
└──────────────┘               │       ↓                         │
                               │  Tool System (7步管线)          │
                               │       ↓                         │
                               │  飞书 Open API（用 Bot 自己的    │
                               │  凭证发消息/卡片/文档）          │
                               └─────────────────────────────────┘
```

### 核心变化

| 维度 | 当前（单 Bot） | 目标（多 Bot） |
|------|--------------|--------------|
| Agent 来源 | 代码硬编码 | 数据库/文件注册 |
| Bot 凭证 | 没有（stub） | 每个 Bot 独立 App ID + Secret |
| 路由 | 单 webhook 路径 | `/feishu/bot/{agentId}` 多路径 |
| Agent 创建 | 改代码 | 飞书群里对话创建 |

---

## 二、Agent 注册存储

每个 Agent 一条记录，当前用 JSON 文件（Phase 1），后续可迁移到 DB。

```json
// agents/data-watcher.json
{
  "id": "data-watcher",
  "displayName": "数据观察员",
  "baseAgent": "secretary",
  "createdAt": "2026-06-28T10:00:00Z",
  "createdBy": "open_id_xxx",

  "feishuBot": {
    "appId": "cli_xxxxx",
    "appSecret": "****",
    "verificationToken": "****",
    "encryptKey": "****"
  },

  "persona": {
    "voiceStyle": "数据驱动，只给量化结论。优先用数字说话。",
    "corePrompt": "你是数据观察员，负责监控业务指标。每天上午9点自动汇报昨日核心数据。发现异常波动立刻告警。"
  },

  "toolScope": {
    "coreTools": ["search_docs", "fetch_memory_context"],
    "stageTools": {
      "reporting": ["create_doc"]
    },
    "approvalRequired": ["create_doc", "send_card"]
  },

  "speakRules": {
    "canInitiate": true,
    "triggers": ["result_ready", "risk_detected"],
    "cooldownMs": 60000
  }
}
```

目录结构：

```
agents/
├── secretary.json        ← 平台默认（系统内置）
├── reviewer.json
├── data-watcher.json     ← 用户创建
└── code-reviewer.json    ← 用户创建
```

---

## 三、飞书群里创建 Agent 的对话流程

用户在群里 @秘书（平台内置 Bot），自然语言创建新 Agent：

```
你：@秘书 创建一个新 Bot，叫"数据观察员"，
    每天早上 9 点汇报昨天的核心数据，有异常自动告警

秘书：好的，我来创建一个"数据观察员"。

【创建成功】
══════════════════════════════════════════
  Agent: 数据观察员 (data-watcher)
  人设:  数据驱动，量化结论，异常告警
  工具:  搜索、文档、知识库
══════════════════════════════════════════

接下来请去飞书开发者后台注册这个 Bot：
https://open.feishu.cn/app

注册后把 App ID 和 App Secret 发给我。

你：App ID: cli_xxx  App Secret: yyy

秘书：✅ 已绑定！数据观察员现在可以接收消息了。

你可以 @数据观察员 跟它对话。
如果它在群里还没出现，请管理员把它拉进群。
```

### 关键设计点

**Secretary 如何理解"创建 Agent"的意图？**

在 `classifyIntent` 之外新增一条路由——检测关键词模式：

```
/创建.*(Bot|机器人|Agent|助手)|叫.*[名称]|新.*Bot/
```

匹配后不走正常的 Agent Loop，而是走 **Agent 创建流程**：

```
用户消息 → 检测到"创建意图"
         → LLM 提取参数（名称、人设、发言规则、工具需求）
         → 写入 agents/{name}.json
         → 回复成功消息 + 提醒注册飞书 Bot
```

**Secretary 如何提取参数？**

用一次轻量 LLM 调用（和 Agent Loop 同一套机制），prompt 为：

```
从用户消息中提取新 Bot 的信息，返回 JSON：
{
  "name": "Bot 名称",
  "voiceStyle": "语气描述",
  "corePrompt": "角色核心指令",
  "triggerEvents": ["主动发言场景"],
  "suggestedTools": ["建议配备的工具"]
}
如果信息不够，返回 {"clarify": ["需要补充的问题列表"]}
```

---

## 四、运行时路由

当前单 webhook 路径 → 改为按 Bot 路由：

```typescript
// src/index.ts — 多 Bot 路由

app.post('/feishu/bot/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const agent = loadAgentProfile(agentId);
  if (!agent) return c.json({ error: 'unknown agent' }, 404);

  // 验证签名（用该 Bot 自己的 verificationToken）
  const body = await c.req.json();
  if (!verifyFeishuSignature(body, agent.feishuBot)) {
    return c.json({ error: 'invalid signature' }, 403);
  }

  // 路由到该 Agent 的执行循环
  const event = normalizeEvent(body);
  if (!event) return c.json({ code: 0 });

  const result = await runAgentLoop(
    assembleSystemPrompt(agent, ctx),
    [{ role: 'user', content: event.payload }],
    toAnthropicTools(agent.toolScope.coreTools),
    toolExecutor(agent),
    DEFAULT_LOOP_CONFIG,
  );

  // 用 Bot 自己的凭证回复
  await replyAsBot(agent, result);

  return c.json({ code: 0 });
});
```

---

## 五、每个 Bot 独立回复

当前 Tool System 的 `send_group_message` 等工具是 stub。多 Bot 架构下，每个工具要用 Bot **自己的** 飞书凭证调用 API：

```typescript
// 工具执行时拿到当前 Agent 的凭证
async function sendMessage(agent: AgentProfile, chatId: string, content: string) {
  const client = new FeishuClient(agent.feishuBot.appId, agent.feishuBot.appSecret);
  await client.sendMessage(chatId, content);
  // 消息显示为"数据观察员"发的，不是"秘书"发的
}
```

**课程对照**：这对应 Harness Engineering 的"权限代理"——每个 Agent 有自己的身份凭证，执行操作时用自己的身份。

---

## 六、实施步骤

```
Step 1: Agent 存储层
  └─ agents/ 目录 + loadAgentProfile() 函数
  └─ 将当前硬编码的 AGENT_PROFILES 改为从 agents/ 加载

Step 2: 多 Bot 路由
  └─ /feishu/bot/:agentId 动态路由
  └─ 每个 Bot 独立签名验证

Step 3: Bot 凭证绑定
  └─ 用户在群里发送 App ID + Secret
  └─ Secretary 接收后写入 agents/{id}.json
  └─ 验证凭证有效性（调一次飞书 API）

Step 4: 对话创建 Agent
  └─ Secretary 识别"创建"意图
  └─ LLM 提取参数 → 写入配置 → 返回成功消息

Step 5: 工具回复代理
  └─ send_group_message 等工具使用 Bot 自身凭证
  └─ 消息来源显示为对应的 Agent
```

---

## 六、Agent 生命周期

创建 Agent 后，还需要支持后续的修改、删除、暂停等操作。所有操作通过管理工具实现，与创建流程一致的 `think→act→observe` 模式。

| 操作 | 命令示例 | 管理工具 | 当前支持 |
|------|---------|---------|---------|
| 创建 | `@秘书 创建一个新 Bot 叫数据观察员` | `create_agent` | ✅ 设计完成 |
| 修改 | `@秘书 把数据观察员的语气改成更严肃` | `edit_agent` | ❌ 待设计 |
| 删除 | `@秘书 删除数据观察员` | `delete_agent` | ❌ 待设计 |
| 暂停 | `@秘书 让数据观察员先别说话` | `toggle_agent` | ❌ 待设计 |
| 列出 | `@秘书 列出所有 Bot` | `list_agents` | ❌ 待设计 |

设计原则：管理工具与普通工具一样注册在 Tool System 中，走相同的 7 步管线（含权限检查）。`create_agent` 和 `delete_agent` 标记为高风险，需要审批。

---

## 七、与课程对照

| 课程概念 | 对应实现 |
|---------|---------|
| Prompt Pipe 可组合模块 | agents/{id}.json 里的 persona |
| Tool Policy 按角色裁剪 | toolScope 字段定义每个 Bot 的工具 |
| 授权代理 | 每个 Bot 独立飞书凭证 |
| Multi-Agent 隔离 | 每个 Bot 独立 webhook + 独立上下文 |
| 记忆系统 | 每个 Bot 有独立的 memory 空间 |
