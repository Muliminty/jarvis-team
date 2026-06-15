# 飞书多Agent协作系统

在飞书群聊中构建一个分工明确的 AI 小团队——不是单个超级助手，而是有分工、有汇报链、有审批机制的多 Agent 协作系统。

## 项目结构

```
src/
├── gateway/          # 飞书事件网关 — 签名校验、去重、消息标准化
├── orchestrator/     # 编排服务 — 意图识别、任务规划、Agent 路由、保险丝
├── agent-runtime/    # Agent 运行时 — 角色 Prompt、Tool Policy、Prompt Pipe
│   └── roles/        # 各角色定义 (secretary / pm / qa-risk / research / worker)
├── tool-service/     # 工具服务 — 飞书 Open API 封装、外部工具
├── state-service/    # 状态服务 — Session / Task / Memory / Mailbox
└── shared/           # 共享类型与工具
```

## 快速开始

```bash
pnpm install
pnpm dev
```

## 架构

详见 `docs/` 目录下的技术架构文档。
