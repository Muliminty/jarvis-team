# Agent 配置参考

> 状态: draft · 代码: 未实现
> 每个 Agent 对应一个 JSON 配置文件，存储在 `agents/{agentId}.json`
> 系统内置 Agent 预置在代码中，运行时合并用户配置覆盖

---

## 完整结构

```jsonc
{
  // ── 基础信息 ──
  "id": "data-watcher",              // 唯一标识，字母数字连字符
  "displayName": "数据观察员",        // 群聊中显示的名称
  "baseAgent": "secretary",          // 继承自哪个内置 Agent（可选）
  "description": "每天早上 9 点汇报核心数据", // 简短描述

  // ── 飞书 Bot 凭证（注册后填写） ──
  "feishuBot": {
    "appId": "cli_xxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxx",
    "verificationToken": "xxxxxxxxxxxxx",
    "encryptKey": ""                  // 可选
  },

  // ── 人设（Persona） ──
  "persona": {
    // 核心 System Prompt — 定义角色行为
    "corePrompt": "你是数据观察员，负责监控业务指标...",
    // 语气描述
    "voiceStyle": "数据驱动，只给量化结论",
    // 额外的 Prompt 模块（可选）
    "extraModules": [
      {
        "name": "morning-report",
        "content": "每天上午 9:00 自动发送昨日核心数据卡片"
      }
    ]
  },

  // ── 工具权限 ──
  "toolScope": {
    // 始终可用的工具
    "coreTools": [
      "search_docs",
      "fetch_memory_context"
    ],
    // 按任务阶段可见的工具
    "stageTools": {
      "reporting": ["create_doc"]
    },
    // 需要二次审批的工具
    "approvalRequired": [
      "create_doc",
      "send_card"
    ]
  },

  // ── 发言规则 ──
  "speakRules": {
    "canInitiate": true,              // 可主动发言
    "triggers": [                     // 触发主动发言的事件
      "result_ready",
      "risk_detected"
    ],
    "cooldownMs": 60000               // 同一任务冷却期
  },

  // ── 创建信息 ──
  "createdBy": "open_id_xxx",
  "createdAt": "2026-06-28T10:00:00Z"
}
```

---

## 字段说明

### 基础信息

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 字母数字连字符，用作 URL 路径和文件名 |
| `displayName` | string | ✅ | 群聊中显示的中文名称 |
| `baseAgent` | string | ❌ | 继承内置 Agent 的默认配置。当前可选：`secretary` |
| `description` | string | ❌ | 简短描述，用于工具搜索 |

### 人设

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `corePrompt` | string | ✅ | 角色定义的 System Prompt 核心内容 |
| `voiceStyle` | string | ❌ | 语气风格描述，不填继承 baseAgent |
| `extraModules` | array | ❌ | 额外的 Prompt 模块，追加到 corePrompt 之后 |

**继承合并规则**：用户配置的 `extraModules` 与 baseAgent 的 `promptModules` 按 `name` 合并。同名模块 → 用户配置覆盖系统默认；不同名 → 追加到模块列表末尾。`voiceStyle` / `coreTools` 等简单字段：用户填写则覆盖，未填写继承 baseAgent 的值。

### 工具权限

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coreTools` | string[] | ✅ | 始终可见的核心工具 |
| `stageTools` | object | ❌ | 按阶段暴露的工具，key 为阶段名 |
| `approvalRequired` | string[] | ❌ | 需要审批后才能调用的工具 |

### 发言规则

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `canInitiate` | boolean | ❌ | 是否可主动发言（默认 false） |
| `triggers` | string[] | ❌ | 触发发言的事件：`result_ready`、`risk_detected`、`blocked`、`approval_needed` |
| `cooldownMs` | number | ❌ | 同一任务冷却毫秒数 |

---

## 内置 Agent 默认值

### secretary（秘书）

```jsonc
{
  "persona": {
    "corePrompt": "你是执行秘书，负责接需求、做总结、发纪要、发提醒、向用户索要决策。",
    "voiceStyle": "稳定、简洁、像执行秘书。不输出长推理，优先给结论和下一步。"
  },
  "toolScope": {
    "coreTools": ["send_group_message", "send_card", "fetch_memory_context"],
    "stageTools": { "reporting": ["search_docs", "tool_search"] },
    "approvalRequired": ["create_doc", "send_card"]
  },
  "speakRules": {
    "canInitiate": true,
    "triggers": ["result_ready", "approval_needed", "blocked"],
    "cooldownMs": 10000
  }
}
```

### reviewer（复核员）

```jsonc
{
  "persona": {
    "corePrompt": "你是复核员，负责检查 Secretary 的输出质量、发现潜在风险和问题、在低置信度时要求人工确认。默认沉默，仅在发现问题时发言。",
    "voiceStyle": "审慎、精确、从风险角度思考。"
  },
  "toolScope": {
    "coreTools": ["search_docs", "fetch_memory_context"],
    "stageTools": { "review": ["tool_search"] },
    "approvalRequired": []
  },
  "speakRules": {
    "canInitiate": false,
    "triggers": ["risk_detected", "approval_needed"],
    "cooldownMs": 60000
  }
}
```

---

## 创建新 Agent 的途径

### 方式一：飞书群里自然语言创建（推荐）

```
你：@秘书 创建一个新 Bot，叫"数据观察员"，
    每天早上汇报数据，有异常主动告警
```

Secretary 自动提取参数，生成配置文件。

### 方式二：手动创建 JSON 文件

```bash
cp agents/secretary.json agents/my-agent.json
# 编辑 my-agent.json，修改 id/displayName/persona 等
# 重启服务
```

### 方式三：API 创建（规划中）

```
POST /api/agents
```
