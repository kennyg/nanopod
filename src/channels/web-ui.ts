/**
 * Self-contained chat UI served as a single HTML page.
 * Inline CSS + JS, no build tooling required.
 */
export function getWebUiHtml(token: string, room: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>NanoPod — ${escapeHtml(room)}</title>
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
  #back-link {
    color: #888; text-decoration: none; font-size: 14px;
    margin-right: 4px;
  }
  #back-link:hover { color: #e0e0e0; }
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
  .msg .sender-label {
    font-size: 11px; font-weight: 600; margin-bottom: 2px;
    display: block; opacity: 0.7;
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
  <a id="back-link" href="/?token=${encodeURIComponent(token)}">&larr;</a>
  <div id="status"></div>
  <h1>${escapeHtml(room)}</h1>
</div>
<div id="messages"></div>
<div id="input-area">
  <textarea id="input" rows="1" placeholder="Message..." autocomplete="off"></textarea>
  <button id="send-btn">Send</button>
</div>
<script>
(function() {
  const token = ${JSON.stringify(token)};
  const room = ${JSON.stringify(room)};
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
    // Show sender label on all messages
    if (msg.sender_name) {
      const label = document.createElement('span');
      label.className = 'sender-label';
      label.textContent = msg.sender_name;
      label.style.color = senderColor(msg.sender_name);
      div.appendChild(label);
    }
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

  // Deterministic color for a sender name
  function senderColor(name) {
    const colors = ['#7eb8da','#a78bfa','#f0abfc','#fbbf24','#34d399','#f87171','#60a5fa','#c084fc'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return colors[Math.abs(hash) % colors.length];
  }

  // Load history
  fetch('/api/rooms/' + encodeURIComponent(room) + '/history?token=' + encodeURIComponent(token))
    .then(r => r.json())
    .then(msgs => { msgs.forEach(appendMessage); scrollToBottom(); })
    .catch(err => console.error('History load failed:', err));

  // SSE connection
  let evtSource;
  function connectSSE() {
    statusEl.className = 'connecting';
    evtSource = new EventSource('/api/rooms/' + encodeURIComponent(room) + '/events?token=' + encodeURIComponent(token));
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
    fetch('/api/rooms/' + encodeURIComponent(room) + '/send?token=' + encodeURIComponent(token), {
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

/**
 * Room list page — shows all web: rooms with links.
 */
export function getRoomListHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>NanoPod — Rooms</title>
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
  #content {
    flex: 1; overflow-y: auto; padding: 16px;
  }
  .room-list {
    list-style: none; display: flex; flex-direction: column; gap: 8px;
  }
  .room-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; background: #222244; border-radius: 10px;
    text-decoration: none; color: #e0e0e0;
    transition: background 0.15s;
  }
  .room-item:hover { background: #2a2a55; }
  .room-name { font-size: 15px; font-weight: 500; }
  .room-meta { font-size: 12px; color: #888; }
  .room-arrow { color: #666; font-size: 18px; }
  #new-room-form {
    display: flex; gap: 8px; margin-top: 16px;
  }
  #new-room-input {
    flex: 1; padding: 10px 14px; border-radius: 20px;
    border: 1px solid #0f3460; background: #1a1a2e; color: #e0e0e0;
    font-size: 14px; font-family: inherit; outline: none;
  }
  #new-room-input:focus { border-color: #533483; }
  #new-room-input::placeholder { color: #666; }
  #new-room-btn {
    padding: 10px 18px; border-radius: 20px;
    border: none; background: #533483; color: #fff;
    font-size: 14px; cursor: pointer; font-weight: 600;
    white-space: nowrap;
  }
  #new-room-btn:hover { background: #6a42a0; }
  #new-room-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .empty-state {
    text-align: center; color: #666; padding: 40px 16px;
    font-size: 14px;
  }
</style>
</head>
<body>
<div id="header">
  <h1>NanoPod</h1>
</div>
<div id="content">
  <ul class="room-list" id="room-list"></ul>
  <div id="new-room-form">
    <input id="new-room-input" type="text" placeholder="New room name..." maxlength="50" />
    <button id="new-room-btn">Create</button>
  </div>
</div>
<script>
(function() {
  const token = ${JSON.stringify(token)};
  const listEl = document.getElementById('room-list');
  const inputEl = document.getElementById('new-room-input');
  const createBtn = document.getElementById('new-room-btn');

  function formatDate(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch { return ''; }
  }

  function renderRooms(rooms) {
    listEl.innerHTML = '';
    if (rooms.length === 0) {
      listEl.innerHTML = '<li class="empty-state">No rooms yet. Create one below.</li>';
      return;
    }
    for (const room of rooms) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'room-item';
      a.href = '/r/' + encodeURIComponent(room.slug) + '?token=' + encodeURIComponent(token);
      a.innerHTML =
        '<div><div class="room-name">' + escapeHtml(room.name) + '</div>' +
        '<div class="room-meta">Created ' + formatDate(room.added_at) + '</div></div>' +
        '<span class="room-arrow">&rsaquo;</span>';
      li.appendChild(a);
      listEl.appendChild(li);
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Load rooms
  fetch('/api/rooms?token=' + encodeURIComponent(token))
    .then(r => r.json())
    .then(rooms => renderRooms(rooms))
    .catch(err => console.error('Failed to load rooms:', err));

  // Create room
  function createRoom() {
    const name = inputEl.value.trim();
    if (!name) return;
    createBtn.disabled = true;
    fetch('/api/rooms?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    })
    .then(r => {
      if (!r.ok) return r.json().then(d => { throw new Error(d.error || 'Failed'); });
      return r.json();
    })
    .then(data => {
      inputEl.value = '';
      window.location.href = '/r/' + encodeURIComponent(data.slug) + '?token=' + encodeURIComponent(token);
    })
    .catch(err => {
      alert('Error: ' + err.message);
    })
    .finally(() => { createBtn.disabled = false; });
  }

  createBtn.addEventListener('click', createRoom);
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      createRoom();
    }
  });
})();
</script>
</body>
</html>`;
}

/** Simple HTML escape for server-side template interpolation */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
