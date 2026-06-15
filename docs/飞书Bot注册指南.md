# 飞书 Bot 注册指南

> 状态: draft · 代码: 未实现
> 每个 Agent = 一个独立的飞书 Bot。管理员需在飞书开发者后台为每个 Agent 注册 Bot，获取凭证后交给系统绑定。

---

## 前置条件

- 飞书企业管理员权限（或管理员协助）
- 每个 Agent 需要单独的飞书应用

---

## 注册步骤

### 1. 进入飞书开发者后台

打开 [https://open.feishu.cn/app](https://open.feishu.cn/app)

### 2. 创建新应用

点击 **创建应用** → **企业自建应用**

填写：
- **名称**：对应 Agent 名称（如"秘书"、"数据观察员"）
- **描述**：简短说明用途
- **图标**：可后续设置

### 3. 获取凭证

创建成功后，进入 **凭证与基础信息** 页面，记录：

```
App ID:           cli_xxxxxxxxxxxxxxx
App Secret:       xxxxxxxxxxxxxxxxxxxxxxxx
Verification Token: xxxxxxxxxxxxxxxxxxxx
Encrypt Key:       xxxxxxxxxxxxxxxxxxxx（可选）
```

### 4. 配置权限

进入 **权限管理**，开通以下权限：

| 权限 | 用途 | 必须 |
|------|------|------|
| `im:message:send_as_bot` | 发送群消息 | ✅ |
| `im:message:receive` | 接收群消息 | ✅ |
| `im:chat:readonly` | 读取群信息 | ✅ |
| `docx:document:create` | 创建文档 | 按需 |
| `docx:document:overwrite` | 编辑文档 | 按需 |
| `bitable:app:readonly` | 读取多维表格 | 按需 |
| `bitable:app:overwrite` | 编辑多维表格 | 按需 |

### 5. 配置事件回调

进入 **事件与回调** → 添加事件：

- `im.message.receive_v1`（接收群消息）

回调地址格式：

```
https://your-server.com/feishu/bot/{agentId}
```

将 `{agentId}` 替换为 Agent 的 ID（如 `data-watcher`）。

### 6. 发布应用

进入 **版本管理与发布** → 创建版本 → 填写更新说明 → 提交发布

需要管理员审批。

### 7. 拉 Bot 入群

发布后，在飞书中找到该 Bot → 添加到目标群聊。

---

## 绑定凭证到系统

注册完成后，在群里 @秘书，发送凭证信息：

```
你：App ID: cli_xxx  App Secret: xxx  Verification Token: xxx

秘书：✅ 已绑定！数据观察员现在可以接收消息了。
```

或直接写入配置文件：

```json
// agents/{agentId}.json
{
  "feishuBot": {
    "appId": "cli_xxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxx",
    "verificationToken": "xxxxxxxxxxxxx"
  }
}
```

---

---

> ⚠️ **安全注意事项**
>
> `appSecret` 当前以明文存储在 JSON 文件中。生产环境建议：
> - 使用密钥管理服务（Vault / 1Password CLI）注入
> - 或通过环境变量传入，不在文件中持久化
> - 后续版本会支持加密存储

---

## 常见问题

**Q: 一个飞书企业能注册多少个 Bot？**
A: 没有硬限制，但每个 Bot 需要单独创建和发布。

**Q: Bot 在群里 @不到？**
A: 确认 Bot 已被拉入群，且事件回调地址配置正确。

**Q: 回调地址可以复用吗？**
A: 每个 Bot 使用不同的 `{agentId}` 路径，但指向同一台服务器。
