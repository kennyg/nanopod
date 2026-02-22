/**
 * Self-contained chat UI served as a single HTML page.
 * Inline CSS + JS, no build tooling required.
 */
export function getWebUiHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>NanoPod</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #1a1a2e; color: #e0e0e0;
    height: 100dvh; display: flex; flex-direction: column;
  }
  #header {
    padding: 12px 16px; background: #16213e;
    border-bottom: 1px solid #0f3460;
    display: flex; align-items: center; gap: 10px;
    flex-shrink: 0;
  }
  #header h1 { font-size: 16px; font-weight: 600; }
  #status {
    width: 8px; height: 8px; border-radius: 50%;
    background: #666; flex-shrink: 0;
  }
  #status.connected { background: #00d26a; }
  #status.connecting { background: #f5a623; }
  #messages {
    flex: 1; overflow-y: auto; padding: 16px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .msg {
    max-width: 80%; padding: 10px 14px;
    border-radius: 12px; line-height: 1.45;
    word-wrap: break-word; white-space: pre-wrap;
    font-size: 14px;
  }
  .msg.user {
    align-self: flex-end; background: #0f3460; color: #fff;
    border-bottom-right-radius: 4px;
  }
  .msg.bot {
    align-self: flex-start; background: #222244; color: #e0e0e0;
    border-bottom-left-radius: 4px;
  }
  .msg .time {
    font-size: 11px; color: #888; margin-top: 4px;
    display: block;
  }
  #input-area {
    padding: 12px 16px; background: #16213e;
    border-top: 1px solid #0f3460;
    display: flex; gap: 8px; flex-shrink: 0;
  }
  #input {
    flex: 1; padding: 10px 14px; border-radius: 20px;
    border: 1px solid #0f3460; background: #1a1a2e; color: #e0e0e0;
    font-size: 14px; font-family: inherit; resize: none;
    max-height: 120px; outline: none;
  }
  #input:focus { border-color: #533483; }
  #input::placeholder { color: #666; }
  #send-btn {
    padding: 10px 18px; border-radius: 20px;
    border: none; background: #533483; color: #fff;
    font-size: 14px; cursor: pointer; font-weight: 600;
    align-self: flex-end;
  }
  #send-btn:hover { background: #6a42a0; }
  #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
<div id="header">
  <div id="status"></div>
  <h1>NanoPod</h1>
</div>
<div id="messages"></div>
<div id="input-area">
  <textarea id="input" rows="1" placeholder="Message..." autocomplete="off"></textarea>
  <button id="send-btn">Send</button>
</div>
<script>
(function() {
  const token = ${JSON.stringify(token)};
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const statusEl = document.getElementById('status');
  const seenIds = new Set();
  let autoScroll = true;

  messagesEl.addEventListener('scroll', function() {
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
    autoScroll = atBottom;
  });

  function scrollToBottom() {
    if (autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatTime(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  function appendMessage(msg) {
    if (seenIds.has(msg.id)) return;
    seenIds.add(msg.id);
    const div = document.createElement('div');
    const isBot = msg.is_bot_message || (!msg.is_from_me && msg.sender === 'bot');
    div.className = 'msg ' + (isBot ? 'bot' : 'user');
    const content = document.createElement('span');
    content.textContent = msg.content;
    div.appendChild(content);
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(msg.timestamp);
    div.appendChild(time);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  // Load history
  fetch('/api/history?token=' + encodeURIComponent(token))
    .then(r => r.json())
    .then(msgs => { msgs.forEach(appendMessage); scrollToBottom(); })
    .catch(err => console.error('History load failed:', err));

  // SSE connection
  let evtSource;
  function connectSSE() {
    statusEl.className = 'connecting';
    evtSource = new EventSource('/api/events?token=' + encodeURIComponent(token));
    evtSource.onopen = function() { statusEl.className = 'connected'; };
    evtSource.addEventListener('message', function(e) {
      try {
        const msg = JSON.parse(e.data);
        appendMessage(msg);
      } catch {}
    });
    evtSource.onerror = function() {
      statusEl.className = '';
      evtSource.close();
      setTimeout(connectSSE, 3000);
    };
  }
  connectSSE();

  // Send message
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtn.disabled = true;
    fetch('/api/send?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    })
    .then(r => r.json())
    .then(data => {
      if (data.message) appendMessage(data.message);
    })
    .catch(err => console.error('Send failed:', err))
    .finally(() => { sendBtn.disabled = false; inputEl.focus(); });
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });
})();
</script>
</body>
</html>`;
}
