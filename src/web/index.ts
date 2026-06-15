// Web 管理界面 — 聊天 + 飞书绑定
// 对应技术架构：Phase 1.5 管理入口

export const CHAT_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jarvis Team Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; height: 100vh; display: flex; }
  .sidebar { width: 320px; background: #fff; border-right: 1px solid #e0e0e0; display: flex; flex-direction: column; padding: 16px; gap: 12px; overflow-y: auto; }
  .main { flex: 1; display: flex; flex-direction: column; }
  .header { padding: 16px 24px; background: #fff; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header .status { font-size: 12px; color: #666; }
  .status.online { color: #22c55e; }
  .status.offline { color: #ef4444; }
  .messages { flex: 1; padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
  .message { max-width: 70%; padding: 12px 16px; border-radius: 12px; line-height: 1.5; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .message.user { align-self: flex-end; background: #2563eb; color: #fff; border-bottom-right-radius: 4px; }
  .message.assistant { align-self: flex-start; background: #fff; color: #1a1a1a; border: 1px solid #e0e0e0; border-bottom-left-radius: 4px; }
  .message.system { align-self: center; background: #f0f0f0; color: #666; font-size: 12px; border: none; }
  .input-area { padding: 16px 24px; background: #fff; border-top: 1px solid #e0e0e0; display: flex; gap: 12px; }
  .input-area textarea { flex: 1; padding: 12px; border: 1px solid #d0d0d0; border-radius: 8px; font-size: 14px; resize: none; min-height: 48px; max-height: 120px; outline: none; font-family: inherit; }
  .input-area textarea:focus { border-color: #2563eb; }
  .input-area button { padding: 12px 24px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: 500; }
  .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
  .input-area button:hover:not(:disabled) { background: #1d4ed8; }

  .section-title { font-size: 13px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 8px; }
  .sidebar label { font-size: 12px; color: #555; display: flex; flex-direction: column; gap: 4px; }
  .sidebar input, .sidebar select { padding: 8px 10px; border: 1px solid #d0d0d0; border-radius: 6px; font-size: 13px; outline: none; }
  .sidebar input:focus, .sidebar select:focus { border-color: #2563eb; }
  .sidebar .btn { padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; border: none; font-weight: 500; }
  .btn.primary { background: #2563eb; color: #fff; }
  .btn.primary:hover { background: #1d4ed8; }
  .btn.success { background: #22c55e; color: #fff; }
  .btn.success:hover { background: #16a34a; }
  .btn.secondary { background: #f0f0f0; color: #333; }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 12px 24px; border-radius: 8px; font-size: 14px; color: #fff; z-index: 999; display: none; }
  .toast.success { background: #22c55e; }
  .toast.error { background: #ef4444; }
  .toast.show { display: block; animation: fadeInOut 2s ease; }
  @keyframes fadeInOut { 0% { opacity: 0; transform: translateX(-50%) translateY(20px); } 15% { opacity: 1; transform: translateX(-50%) translateY(0); } 85% { opacity: 1; } 100% { opacity: 0; } }
  .typing { font-size: 13px; color: #999; padding: 4px 12px; }
  .msg-time { font-size: 11px; color: rgba(0,0,0,0.4); margin-top: 4px; }
  .msg-time.user { color: rgba(255,255,255,0.6); }
  pre { background: #1a1a2e; color: #e0e0e0; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; margin: 8px 0; }
  code { font-family: 'JetBrains Mono', 'Fira Code', monospace; }
</style>
</head>
<body>

<div class="sidebar" id="sidebar">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="#2563eb"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
    <span style="font-weight:600;font-size:16px;">Jarvis Team</span>
  </div>

  <div class="section-title">会话</div>
  <label>
    Agent
    <select id="agentSelect"></select>
  </label>

  <div class="section-title" style="margin-top:12px;">飞书绑定</div>
  <label>App ID <input id="feishuAppId" placeholder="cli_xxxxxxxxxxxx"></label>
  <label>App Secret <input id="feishuAppSecret" type="password" placeholder="xxxxxxxx"></label>
  <label>Verification Token <input id="feishuVerifToken" placeholder="可选"></label>
  <label>绑定到 Agent <select id="bindAgentSelect"></select></label>
  <button class="btn success" onclick="bindFeishu()">保存飞书配置</button>

  <div class="section-title" style="margin-top:12px;">工具</div>
  <button class="btn secondary" onclick="listAgents()" style="width:100%;">刷新 Agent 列表</button>
  <div id="agentList" style="font-size:12px;color:#666;margin-top:4px;"></div>
</div>

<div class="main">
  <div class="header">
    <h1 id="chatTitle">与 助手 对话</h1>
    <span class="status offline" id="connectionStatus">● 未连接</span>
  </div>

  <div class="messages" id="messages">
    <div class="message system">输入消息开始对话</div>
  </div>

  <div class="input-area">
    <textarea id="messageInput" placeholder="输入消息..." rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
    <button id="sendBtn" onclick="sendMessage()">发送</button>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const API = '';
let agentId = 'assistant';
let isSending = false;

async function fetchApi(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refreshAgents() {
  const health = await fetchApi('/health');
  const selectors = ['agentSelect', 'bindAgentSelect'];
  for (const id of selectors) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    sel.innerHTML = health.agents.map(a => '<option value="'+a+'">'+a+'</option>').join('');
  }
  if (health.agents.includes('assistant')) {
    document.getElementById('agentSelect').value = 'assistant';
    agentId = 'assistant';
    document.getElementById('chatTitle').textContent = '与 助手 对话';
  }
  document.getElementById('connectionStatus').className = health.anthropicKeySet ? 'status online' : 'status offline';
  document.getElementById('connectionStatus').textContent = health.anthropicKeySet ? '● 已连接' : '● 未设置 API Key';
  return health;
}

async function listAgents() {
  const health = await refreshAgents();
  document.getElementById('agentList').textContent = health.agents.length + ' 个 Agent: ' + health.agents.join(', ');
}

function addMessage(role, content) {
  const el = document.createElement('div');
  el.className = 'message ' + role;
  el.textContent = content;
  document.getElementById('messages').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth' });
}

function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || isSending) return;

  agentId = document.getElementById('agentSelect').value;
  document.getElementById('chatTitle').textContent = '与 ' + agentId + ' 对话';

  addMessage('user', text);
  input.value = '';
  isSending = true;
  document.getElementById('sendBtn').disabled = true;

  // typing indicator
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.textContent = agentId + ' 正在输入...';
  document.getElementById('messages').appendChild(typing);

  try {
    const result = await fetchApi('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, agent: agentId }),
    });
    typing.remove();

    // 显示 assistant 回复
    const msgs = result.messages || [];
    const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
    if (lastAssistant) {
      const content = typeof lastAssistant.content === 'string' ? lastAssistant.content
        : Array.isArray(lastAssistant.content) ? lastAssistant.content.map(b => b.text || JSON.stringify(b.input)).join('\\n')
        : JSON.stringify(lastAssistant.content);
      addMessage('assistant', content);
    }

    // 显示退出原因
    if (result.exitReason && result.exitReason.type !== 'completed') {
      addMessage('system', '⏹ ' + result.exitReason.message);
    }

    // 显示用量
    if (result.usage) {
      addMessage('system', '⚡ ' + result.usage.turnCount + ' 轮 | ' + result.usage.totalOutputTokens + ' 输出 tokens');
    }
  } catch (err) {
    typing.remove();
    addMessage('system', '❌ 请求失败: ' + err.message);
  }

  isSending = false;
  document.getElementById('sendBtn').disabled = false;
  input.focus();
}

async function bindFeishu() {
  const agentId = document.getElementById('bindAgentSelect').value;
  const appId = document.getElementById('feishuAppId').value.trim();
  const appSecret = document.getElementById('feishuAppSecret').value.trim();
  const verifToken = document.getElementById('feishuVerifToken').value.trim();

  if (!appId || !appSecret) {
    showToast('请填写 App ID 和 App Secret', 'error');
    return;
  }

  try {
    const result = await fetchApi('/api/agents/' + agentId + '/feishu-bot', {
      method: 'POST',
      body: JSON.stringify({ appId, appSecret, verificationToken: verifToken || undefined }),
    });
    if (result.success) {
      showToast('✅ 飞书配置已保存到 ' + agentId);
      document.getElementById('feishuAppId').value = '';
      document.getElementById('feishuAppSecret').value = '';
      document.getElementById('feishuVerifToken').value = '';
    } else {
      showToast('❌ ' + (result.error || '保存失败'), 'error');
    }
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

// 初始化
refreshAgents().then(h => {
  if (h.agents.length) document.getElementById('agentList').textContent = h.agents.length + ' 个 Agent: ' + h.agents.join(', ');
});
</script>
</body>
</html>`;
