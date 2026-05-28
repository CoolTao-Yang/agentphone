/* agentphone — browser client.
 * - WebSocket to /ws (token in URL ?token=...).
 * - Token-level streaming of assistant text (re-parsed every 100ms).
 * - Tool calls render as inline cards with approve / deny / "本轮全 approve".
 * - Sessions drawer fetched via /api/sessions; pick / rename / delete.
 * - When a session is picked, last N history messages are fetched from
 *   /api/sessions/:id/messages and rendered so the phone has the same
 *   working context as the desktop.
 * - Voice: SpeechRecognition (STT) + speechSynthesis (TTS) with diagnostic
 *   surface so failures aren't silent.
 */
(() => {
  'use strict';

  // ─── token & URL ──────────────────────────────────────────────
  const URL_PARAMS = new URL(location.href).searchParams;
  const TOKEN = URL_PARAMS.get('token') || '';
  const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL = `${WS_PROTO}//${location.host}/ws?token=${encodeURIComponent(TOKEN)}`;

  // ─── DOM refs ─────────────────────────────────────────────────
  const $messages   = document.getElementById('messages');
  const $empty      = document.getElementById('empty');
  const $input      = document.getElementById('input');
  const $send       = document.getElementById('send-btn');
  const $stop       = document.getElementById('stop-btn');
  const $mic        = document.getElementById('mic-btn');
  const $attachBtn  = document.getElementById('attach-btn');
  const $filePicker = document.getElementById('file-picker');
  const $chips      = document.getElementById('attach-chips');
  const $tts        = document.getElementById('tts-toggle');
  const $autoBtn    = document.getElementById('auto-toggle');
  const $debugBtn   = document.getElementById('debug-toggle');
  const $debug      = document.getElementById('debug');
  const $dot        = document.getElementById('status-dot');
  const $statusText = document.getElementById('status-text');
  const $hCwd       = document.getElementById('h-cwd');
  const $hAcct      = document.getElementById('h-acct');
  const $toast      = document.getElementById('toast');

  // drawer + modals
  const $openDrawer  = document.getElementById('open-drawer');
  const $closeDrawer = document.getElementById('close-drawer');
  const $drawer      = document.getElementById('drawer');
  const $drawerBd    = document.getElementById('drawer-bd');
  const $sessionList = document.getElementById('session-list');
  const $newSessionBtn = document.getElementById('new-session');
  const $newModal    = document.getElementById('new-modal');
  const $nsName      = document.getElementById('ns-name');
  const $nsCwd       = document.getElementById('ns-cwd');
  const $nsCwdSug    = document.getElementById('ns-cwd-suggest');
  const $nsCreate    = document.getElementById('ns-create');
  const $renameModal = document.getElementById('rename-modal');
  const $rnName      = document.getElementById('rn-name');
  const $rnSave      = document.getElementById('rn-save');

  // ─── state ────────────────────────────────────────────────────
  let ws = null;
  let reconnectAttempts = 0;
  let busy = false;
  let ttsOn = false;
  let zhVoice = null;
  let currentSessionId = null;
  let currentCwd = '';
  let defaultCwd = '';
  let renamingSessionId = null;
  /** @type {Array<{ data: string, mediaType: string, name?: string }>} */
  let pendingImages = [];
  /** @type {{ autoApproveTools: boolean, effort: string }} */
  let settings = { autoApproveTools: false, effort: 'max' };

  function reflectSettings() {
    $autoBtn.setAttribute('aria-pressed', String(settings.autoApproveTools));
    $autoBtn.title = settings.autoApproveTools
      ? '自动批准工具调用 (yolo) — 已开 · 点击关闭'
      : '自动批准工具调用 (yolo) — 关 · 点击开启';
  }

  // streaming text state per (messageId:blockIndex)
  /** @type {Map<string, { rawText: string, el: HTMLElement, pendingRender: boolean, lastRender: number, kind: 'text'|'thinking' }>} */
  const streamState = new Map();

  // tool cards by toolUseId
  /** @type {Map<string, { card: HTMLElement, resolved: boolean }>} */
  const toolCards = new Map();

  // ─── utilities ────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function renderMarkdown(text) {
    if (!window.marked) return `<pre>${escapeHtml(text)}</pre>`;
    try {
      // Standard markdown rendering: a single \n is whitespace, not a <br>.
      // (We used to have breaks:true which forced every single newline into
      // a line break, which made Claude's prose look like a wall of broken
      // lines on phone.) Paragraph separation comes from real blank lines.
      return window.marked.parse(text, { gfm: true, breaks: false, async: false });
    } catch {
      return `<pre>${escapeHtml(text)}</pre>`;
    }
  }
  function highlightInside(root) {
    if (!window.hljs) return;
    root.querySelectorAll('pre code:not(.hljs)').forEach((el) => {
      try { window.hljs.highlightElement(el); } catch {}
    });
  }

  function showToast(text, kind = 'info', ms = 2400) {
    $toast.textContent = text;
    $toast.className = 'toast show' + (kind && kind !== 'info' ? ' ' + kind : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => $toast.classList.remove('show'), ms);
  }

  function log(level, msg) {
    // local debug panel
    if ($debug) {
      const line = document.createElement('div');
      line.className = 'l-' + level;
      line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      $debug.appendChild(line);
      while ($debug.childElementCount > 80) $debug.firstElementChild.remove();
      $debug.scrollTop = $debug.scrollHeight;
    }
    // ship to server so the desktop side can tail /tmp/agentphone-phone.log
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'log', level, message: msg, ts: Date.now() }));
      } catch { /* ignore */ }
    }
  }

  function setStatus(cls, text) {
    $dot.className = 'h-dot' + (cls ? ' ' + cls : '');
    $statusText.textContent = text;
  }
  function setBusy(b) {
    busy = b;
    $send.disabled = busy || (!$input.value.trim() && pendingImages.length === 0);
    $stop.classList.toggle('hidden', !busy);
    $send.classList.toggle('hidden', busy);
    if (busy) setStatus('busy', '思考中');
    else if (ws && ws.readyState === 1) setStatus('connected', '已连接');
  }

  function autoScroll() {
    const m = $messages;
    const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    if (nearBottom) m.scrollTop = m.scrollHeight;
  }

  function clearEmpty() {
    const e = document.getElementById('empty');
    if (e) e.remove();
  }

  function setCwdDisplay(cwd) {
    currentCwd = cwd || '';
    $hCwd.textContent = currentCwd ? '· ' + currentCwd : '';
    $hCwd.title = currentCwd;
  }

  function setAccountDisplay(name) {
    if (!name || name === '(default)') {
      $hAcct.textContent = '';
      $hAcct.title = '';
    } else {
      $hAcct.textContent = name;
      $hAcct.title = `claude account: ${name}`;
    }
  }

  // ─── streaming text blocks ────────────────────────────────────
  // Merge consecutive assistant (or thinking) text blocks into ONE
  // container so the same "claude" header isn't repeated for every
  // sub-block. A new container starts whenever something else
  // (user msg, tool card, result line, history separator…) intervenes.
  function ensureAssistantContainer(kind) {
    clearEmpty();
    const wantClass = kind === 'thinking' ? 'thinking' : 'assistant';
    const last = $messages.lastElementChild;
    if (last && last.classList.contains('msg') && last.classList.contains(wantClass)) {
      return last.querySelector('.body');
    }
    const msg = document.createElement('div');
    msg.className = 'msg ' + wantClass;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = kind === 'thinking' ? 'thinking' : 'claude';
    const body = document.createElement('div');
    body.className = 'body';
    msg.appendChild(who);
    msg.appendChild(body);
    $messages.appendChild(msg);
    autoScroll();
    return body;
  }

  function newAssistantBlockEl(container) {
    const el = document.createElement('div');
    el.className = 'mblock';
    container.appendChild(el);
    return el;
  }

  function onAssistantBlockStart(evt) {
    if (evt.blockType !== 'text' && evt.blockType !== 'thinking') return;
    const key = `${evt.messageId}:${evt.blockIndex}`;
    if (streamState.has(key)) return;
    const container = ensureAssistantContainer(evt.blockType);
    const el = newAssistantBlockEl(container);
    streamState.set(key, {
      rawText: '',
      el,
      pendingRender: false,
      lastRender: 0,
      kind: evt.blockType,
    });
  }

  function scheduleRender(state) {
    if (state.pendingRender) return;
    state.pendingRender = true;
    const elapsed = Date.now() - state.lastRender;
    const wait = elapsed < 100 ? 100 - elapsed : 0;
    setTimeout(() => {
      state.pendingRender = false;
      state.lastRender = Date.now();
      if (state.kind === 'thinking') {
        state.el.textContent = state.rawText;
      } else {
        state.el.innerHTML = renderMarkdown(state.rawText);
      }
      autoScroll();
    }, wait);
  }

  function onTextDelta(evt) {
    const key = `${evt.messageId}:${evt.blockIndex}`;
    let s = streamState.get(key);
    if (!s) {
      const container = ensureAssistantContainer('text');
      const el = newAssistantBlockEl(container);
      s = { rawText: '', el, pendingRender: false, lastRender: 0, kind: 'text' };
      streamState.set(key, s);
    }
    s.rawText += evt.delta;
    scheduleRender(s);
  }

  function onThinkingDelta(evt) {
    const key = `${evt.messageId}:${evt.blockIndex}`;
    let s = streamState.get(key);
    if (!s) {
      const container = ensureAssistantContainer('thinking');
      const el = newAssistantBlockEl(container);
      s = { rawText: '', el, pendingRender: false, lastRender: 0, kind: 'thinking' };
      streamState.set(key, s);
    }
    s.rawText += evt.delta;
    scheduleRender(s);
  }

  function onAssistantBlockEnd(evt) {
    const key = `${evt.messageId}:${evt.blockIndex}`;
    const s = streamState.get(key);
    if (!s) return;
    if (s.kind === 'text') {
      s.el.innerHTML = renderMarkdown(s.rawText);
      highlightInside(s.el);
      if (ttsOn) speak(stripForTTS(s.rawText));
    } else {
      s.el.textContent = s.rawText;
    }
    autoScroll();
    streamState.delete(key);
  }

  // ─── user message ─────────────────────────────────────────────
  function appendUser(text, images) {
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'msg user';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = '你';
    const body = document.createElement('div');
    body.className = 'body';
    if (text) body.textContent = text;
    if (images && images.length) {
      const imgs = document.createElement('div');
      imgs.className = 'msg-images';
      for (const img of images) {
        const el = document.createElement('img');
        el.className = 'msg-img-thumb';
        el.src = `data:${img.mediaType};base64,${img.data}`;
        el.alt = img.name || 'image';
        el.addEventListener('click', () => {
          const w = window.open('', '_blank');
          if (w) {
            w.document.write(
              `<title>${escapeHtml(img.name || 'image')}</title>` +
              `<body style="margin:0;background:#0d0c0b;display:flex;align-items:center;justify-content:center;height:100vh">` +
              `<img src="${el.src}" style="max-width:100%;max-height:100%"></body>`
            );
          }
        });
        imgs.appendChild(el);
      }
      body.appendChild(imgs);
    }
    div.appendChild(who);
    div.appendChild(body);
    $messages.appendChild(div);
    autoScroll();
  }

  // ─── tool cards ───────────────────────────────────────────────
  function oneLineInputSummary(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input.slice(0, 100);
    if (typeof input !== 'object') return String(input).slice(0, 100);
    for (const k of ['file_path', 'path', 'command', 'query', 'pattern', 'url', 'prompt', 'description']) {
      const v = input[k];
      if (typeof v === 'string') return v.slice(0, 100);
    }
    try { return JSON.stringify(input).slice(0, 100); } catch { return ''; }
  }

  function appendToolRequest(toolUseId, toolName, input, autoApproved) {
    clearEmpty();
    const msg = document.createElement('div');
    msg.className = 'msg tool';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = autoApproved ? '工具调用（自动 approve）' : '工具调用';
    const body = document.createElement('div');
    body.className = 'body';

    const card = document.createElement('div');
    card.className = 'tool-card ' + (autoApproved ? '' : 'pending');
    card.dataset.toolId = toolUseId;

    const header = document.createElement('header');
    const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▸';
    const tName = document.createElement('span'); tName.className = 't-name'; tName.textContent = toolName;
    const tArg  = document.createElement('span'); tArg.className  = 't-arg';  tArg.textContent  = oneLineInputSummary(input);
    const tStatus = document.createElement('span'); tStatus.className = 't-status';
    tStatus.textContent = autoApproved ? '运行中' : '待批准';
    header.appendChild(chev); header.appendChild(tName); header.appendChild(tArg); header.appendChild(tStatus);
    header.addEventListener('click', () => card.classList.toggle('open'));

    const tBody = document.createElement('div');
    tBody.className = 'tool-body';
    const pre = document.createElement('pre');
    try {
      pre.textContent = JSON.stringify(input, null, 2);
    } catch {
      pre.textContent = String(input);
    }
    tBody.appendChild(pre);

    card.appendChild(header);
    card.appendChild(tBody);

    if (!autoApproved) {
      const approveBox = document.createElement('div');
      approveBox.className = 'tool-approve';

      const labelAll = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `all-${toolUseId}`;
      const lt = document.createElement('span');
      lt.textContent = '本轮其他' + toolName + ' 自动 approve';
      labelAll.appendChild(cb);
      labelAll.appendChild(lt);

      const allowBtn = document.createElement('button');
      allowBtn.className = 'tool-btn allow';
      allowBtn.textContent = '✓ 批准';
      const denyBtn = document.createElement('button');
      denyBtn.className = 'tool-btn deny';
      denyBtn.textContent = '✗ 拒绝';

      allowBtn.addEventListener('click', () => {
        sendWS({ type: 'tool_response', toolUseId, decision: 'allow', allowRestOfTurn: cb.checked });
        markToolResolved(toolUseId, 'allow');
      });
      denyBtn.addEventListener('click', () => {
        sendWS({ type: 'tool_response', toolUseId, decision: 'deny' });
        markToolResolved(toolUseId, 'deny');
      });

      approveBox.appendChild(labelAll);
      approveBox.appendChild(denyBtn);
      approveBox.appendChild(allowBtn);
      card.appendChild(approveBox);
    }

    body.appendChild(card);
    msg.appendChild(who);
    msg.appendChild(body);
    $messages.appendChild(msg);
    autoScroll();

    toolCards.set(toolUseId, { card, resolved: !!autoApproved });
  }

  function markToolResolved(toolUseId, decision) {
    const entry = toolCards.get(toolUseId);
    if (!entry) return;
    entry.resolved = true;
    const card = entry.card;
    const approveBox = card.querySelector('.tool-approve');
    if (approveBox) approveBox.remove();
    const status = card.querySelector('.t-status');
    card.classList.remove('pending');
    if (decision === 'deny') {
      card.classList.add('denied');
      if (status) { status.textContent = '已拒绝'; status.classList.add('bad'); }
    } else {
      if (status) { status.textContent = '运行中'; status.classList.add('go'); }
    }
  }

  function onToolResult(toolUseId, content, isError) {
    const entry = toolCards.get(toolUseId);
    if (!entry) {
      // no card existed — surface result anyway as a tool msg
      clearEmpty();
      const msg = document.createElement('div');
      msg.className = 'msg tool';
      const who = document.createElement('div'); who.className = 'who';
      who.textContent = '工具结果';
      const body = document.createElement('div'); body.className = 'body';
      const pre = document.createElement('pre');
      pre.textContent = content;
      body.appendChild(pre);
      msg.appendChild(who); msg.appendChild(body);
      $messages.appendChild(msg);
      autoScroll();
      return;
    }
    const card = entry.card;
    const status = card.querySelector('.t-status');
    card.classList.add('open');
    if (isError) { card.classList.add('error'); if (status) { status.textContent = '错误'; status.classList.remove('go'); status.classList.add('bad'); } }
    else { if (status) { status.textContent = '完成'; status.classList.remove('go'); status.classList.add('ok'); } }
    const tBody = card.querySelector('.tool-body');
    const r = document.createElement('div');
    r.className = 't-result' + (isError ? ' err' : '');
    r.textContent = content;
    tBody.appendChild(r);
    autoScroll();
  }

  // ─── result line ──────────────────────────────────────────────
  function appendResult(payload) {
    clearEmpty();
    const msg = document.createElement('div');
    msg.className = 'msg result';
    const who = document.createElement('div'); who.className = 'who'; who.textContent = '——';
    const body = document.createElement('div'); body.className = 'body';
    const ok = payload.success && !payload.isError;
    const dur = (payload.durationMs / 1000).toFixed(1);
    const cost = (payload.costUsd || 0).toFixed(4);
    body.innerHTML =
      `<span class="${ok ? 'ok' : 'err'}">${ok ? '✓ done' : '⚠ error'}</span>` +
      ` · ${dur}s · ${payload.turns || 0} turns · $${cost}`;
    msg.appendChild(who); msg.appendChild(body);
    $messages.appendChild(msg);
    autoScroll();
  }

  function appendError(text) {
    clearEmpty();
    const msg = document.createElement('div');
    msg.className = 'msg error';
    const who = document.createElement('div'); who.className = 'who'; who.textContent = '错误';
    const body = document.createElement('div'); body.className = 'body'; body.textContent = text;
    msg.appendChild(who); msg.appendChild(body);
    $messages.appendChild(msg);
    autoScroll();
  }

  // ─── agent event dispatch ─────────────────────────────────────
  function dispatchAgentEvent(evt) {
    switch (evt.kind) {
      case 'session_init':
        currentSessionId = evt.sessionId;
        log('info', 'session init ' + evt.sessionId.slice(0, 8));
        return;
      case 'assistant_block_start':
        return onAssistantBlockStart(evt);
      case 'text_delta':
        return onTextDelta(evt);
      case 'thinking_delta':
        return onThinkingDelta(evt);
      case 'assistant_block_end':
        return onAssistantBlockEnd(evt);
      case 'tool_request':
        return appendToolRequest(evt.toolUseId, evt.toolName, evt.input, !!evt.autoApproved);
      case 'tool_decision': {
        const entry = toolCards.get(evt.toolUseId);
        if (entry && !entry.resolved) {
          markToolResolved(evt.toolUseId, evt.allowed ? 'allow' : 'deny');
        }
        return;
      }
      case 'tool_result':
        return onToolResult(evt.toolUseId, evt.content, evt.isError);
      case 'result':
        return appendResult(evt);
    }
  }

  // ─── WebSocket ────────────────────────────────────────────────
  function sendWS(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function connect() {
    setStatus('', '连接中');
    log('info', 'ws connecting');
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      setStatus('error', '无法连接');
      log('error', 'ws ctor: ' + (e && e.message || e));
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
      setStatus('connected', '已连接');
      log('ok', 'ws open');
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case 'connected':
          defaultCwd = m.defaultCwd;
          setCwdDisplay(m.currentCwd);
          setAccountDisplay(m.claudeAccount);
          currentSessionId = m.currentSessionId;
          if (m.settings) { settings = m.settings; reflectSettings(); }
          log('ok',
            `connected · account=${m.claudeAccount} · cwd=${m.currentCwd} · ` +
            `auto=${settings.autoApproveTools} · effort=${settings.effort} · ` +
            `turn=${m.activeTurn ? (m.activeTurn.done ? 'done' : 'running') : 'none'}`);
          if (m.activeTurn && m.activeTurn.events && m.activeTurn.events.length) {
            clearMessages();
            for (const e of m.activeTurn.events) dispatchAgentEvent(e);
            const sec = Math.max(1, Math.round((Date.now() - m.activeTurn.startedAt) / 1000));
            const sep = document.createElement('div');
            sep.className = 'history-sep';
            sep.textContent = m.activeTurn.done
              ? `── 已恢复 ${m.activeTurn.events.length} 条事件（${sec}s 前完成）──`
              : `── 已恢复 ${m.activeTurn.events.length} 条事件（${sec}s 前开始 · server 还在跑）──`;
            $messages.appendChild(sep);
            setBusy(!m.activeTurn.done);
            showToast(m.activeTurn.done ? '已恢复（已完成）' : '已恢复进行中的对话', 'ok', 2500);
          } else {
            // Safety: clear any stale busy state from before disconnect.
            setBusy(false);
          }
          loadSessions();
          loadRecentCwds();
          break;
        case 'session_set':
          currentSessionId = m.sessionId;
          setCwdDisplay(m.cwd);
          log('info', 'session set ' + (m.sessionId ? m.sessionId.slice(0,8) : '(new)') + ' cwd=' + m.cwd);
          break;
        case 'agent_event':
          dispatchAgentEvent(m.event);
          break;
        case 'turn_done':
          setBusy(false);
          // reload sessions to update list (current session moved to top)
          loadSessions();
          break;
        case 'error':
          appendError(m.message);
          setBusy(false);
          showToast(m.message, 'error', 3500);
          log('error', m.message);
          break;
        case 'unauthorized':
          setStatus('error', 'token 错误');
          appendError('URL 里的 token 不对');
          log('error', 'unauthorized');
          break;
        case 'settings':
          settings = m.settings;
          reflectSettings();
          log('info', `settings: auto=${settings.autoApproveTools} effort=${settings.effort}`);
          break;
      }
    };

    ws.onclose = (ev) => {
      if (ev.code === 4001) { setStatus('error', '未授权'); return; }
      setStatus('error', '断开,重连中');
      setBusy(false);
      log('warn', `ws closed code=${ev.code} reason=${ev.reason || '-'} wasClean=${ev.wasClean}`);
      const wait = Math.min(8000, 500 * (1 + reconnectAttempts++));
      setTimeout(connect, wait);
    };
    ws.onerror = () => {
      log('error', `ws error (readyState=${ws ? ws.readyState : 'null'} online=${navigator.onLine})`);
    };
  }

  // ─── sessions REST ────────────────────────────────────────────
  let recentCwdList = [];

  async function loadSessions() {
    try {
      const r = await fetch(`/api/sessions?token=${encodeURIComponent(TOKEN)}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const sessions = await r.json();
      renderSessionList(sessions);
    } catch (e) {
      log('error', 'load sessions: ' + (e.message || e));
    }
  }

  async function loadRecentCwds() {
    try {
      const r = await fetch(`/api/recent-cwds?token=${encodeURIComponent(TOKEN)}`);
      if (!r.ok) return;
      const j = await r.json();
      recentCwdList = j.cwds || [];
    } catch {}
  }

  function fmtRelative(ms) {
    const d = Date.now() - ms;
    if (d < 60_000) return '刚刚';
    if (d < 3_600_000) return Math.floor(d / 60_000) + '分钟前';
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + '小时前';
    if (d < 7 * 86_400_000) return Math.floor(d / 86_400_000) + '天前';
    return new Date(ms).toLocaleDateString();
  }

  function renderSessionList(sessions) {
    if (!sessions.length) {
      $sessionList.innerHTML = `<div class="empty" style="padding:24px 16px;font-size:12px;">还没有 session<br><span style="opacity:.65;">点 "+ 新建"</span></div>`;
      return;
    }
    $sessionList.innerHTML = '';
    for (const s of sessions) {
      const div = document.createElement('div');
      div.className = 'session-item' + (s.sessionId === currentSessionId ? ' active' : '');
      div.dataset.sid = s.sessionId;
      div.dataset.cwd = s.cwd;

      const name = document.createElement('div');
      name.className = 'si-name' + (s.name ? '' : ' unnamed');
      name.textContent = s.name || '(未命名)';
      const agent = s.agent || 'claude';
      const badge = document.createElement('span');
      badge.className = `agent-badge agent-${agent}`;
      badge.textContent = agent;
      name.appendChild(badge);

      const cwd = document.createElement('div');
      cwd.className = 'si-cwd';
      cwd.textContent = s.cwd;
      cwd.title = s.cwd;

      const meta = document.createElement('div');
      meta.className = 'si-meta';
      const preview = document.createElement('span');
      preview.className = 'si-preview';
      preview.textContent = s.preview || '';
      const t = document.createElement('span');
      t.textContent = `${fmtRelative(s.lastUsed)} · ${s.turns}t`;
      meta.appendChild(preview);
      meta.appendChild(t);

      const actions = document.createElement('div');
      actions.className = 'session-actions';
      const ren = document.createElement('button');
      ren.title = '重命名';
      ren.textContent = '✎';
      ren.addEventListener('click', (e) => { e.stopPropagation(); openRenameModal(s.sessionId, s.name); });
      const del = document.createElement('button');
      del.title = '删除';
      del.textContent = '✕';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除 session "${s.name || s.preview.slice(0,20) || s.sessionId.slice(0,8)}"？`)) return;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}?token=${encodeURIComponent(TOKEN)}`, { method: 'DELETE' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          showToast('已删除', 'ok');
          loadSessions();
          if (s.sessionId === currentSessionId) startNewSession(currentCwd);
        } catch (err) {
          showToast('删除失败: ' + (err.message || err), 'error');
        }
      });
      actions.appendChild(ren);
      actions.appendChild(del);

      div.appendChild(name);
      div.appendChild(cwd);
      div.appendChild(meta);
      div.appendChild(actions);

      div.addEventListener('click', () => {
        selectSession(s.sessionId, s.cwd);
      });

      $sessionList.appendChild(div);
    }
  }

  function selectSession(sessionId, cwd) {
    if (sessionId === currentSessionId && cwd === currentCwd) {
      closeDrawer();
      return;
    }
    sendWS({ type: 'select_session', sessionId, cwd });
    clearMessages();
    currentSessionId = sessionId;
    setCwdDisplay(cwd);
    closeDrawer();
    showToast(`已切换到 session ${sessionId.slice(0,8)}`, 'info');
    // Materialize last ~30 history messages so the phone shows the same
    // ongoing context as the desktop.
    fetchAndRenderHistory(sessionId);
  }

  async function fetchAndRenderHistory(sessionId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'history-sep loading';
    placeholder.textContent = '── 加载历史… ──';
    $messages.appendChild(placeholder);
    autoScroll();

    try {
      const r = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages` +
        `?token=${encodeURIComponent(TOKEN)}&limit=30`
      );
      if (!r.ok) {
        placeholder.textContent = `── 加载历史失败 (HTTP ${r.status}) ──`;
        placeholder.classList.add('err');
        return;
      }
      const data = await r.json();
      const msgs = data.messages || [];
      placeholder.remove();

      if (!msgs.length) {
        const sep = document.createElement('div');
        sep.className = 'history-sep';
        sep.textContent = '── 这是一个空 session ──';
        $messages.appendChild(sep);
        return;
      }

      for (const m of msgs) {
        if (m.role === 'user') {
          appendUser(m.text);
        } else if (m.role === 'assistant') {
          renderHistoricalAssistant(m.text);
        } else if (m.role === 'tool_use') {
          appendToolRequest(m.toolUseId, m.name, m.input, true);
        } else if (m.role === 'tool_result') {
          onToolResult(m.toolUseId, m.content, m.isError);
        }
      }

      const sep = document.createElement('div');
      sep.className = 'history-sep';
      const moreNote = data.total > msgs.length
        ? `（共 ${data.total} 条，已加载最近 ${msgs.length}）`
        : '';
      sep.textContent = `── 历史 ${msgs.length} 条${moreNote} · 新消息从下面开始 ──`;
      $messages.appendChild(sep);
      // After loading history, force scroll to bottom regardless of where
      // the user was (autoScroll's near-bottom heuristic doesn't help here
      // because the content height just exploded).
      requestAnimationFrame(() => {
        $messages.scrollTop = $messages.scrollHeight;
        // double-tap on the next frame in case images haven't laid out yet
        requestAnimationFrame(() => {
          $messages.scrollTop = $messages.scrollHeight;
        });
      });
    } catch (e) {
      placeholder.textContent = '── 加载历史出错: ' + (e.message || e) + ' ──';
      placeholder.classList.add('err');
      log('error', 'history fetch: ' + (e.message || e));
    }
  }

  function renderHistoricalAssistant(text) {
    const container = ensureAssistantContainer('text');
    const el = newAssistantBlockEl(container);
    el.innerHTML = renderMarkdown(text);
    highlightInside(el);
  }

  function startNewSession(cwd) {
    sendWS({ type: 'select_session', sessionId: null, cwd });
    clearMessages();
    currentSessionId = null;
    setCwdDisplay(cwd);
  }

  function clearMessages() {
    streamState.clear();
    toolCards.clear();
    $messages.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'empty'; e.id = 'empty';
    e.textContent = '新对话';
    $messages.appendChild(e);
  }

  function openDrawer() {
    $drawer.classList.add('open');
    $drawerBd.classList.add('open');
    $drawer.setAttribute('aria-hidden', 'false');
    loadSessions();
  }
  function closeDrawer() {
    $drawer.classList.remove('open');
    $drawerBd.classList.remove('open');
    $drawer.setAttribute('aria-hidden', 'true');
  }

  // ─── new session modal ────────────────────────────────────────
  function openNewSessionModal() {
    $nsName.value = '';
    $nsCwd.value = currentCwd || defaultCwd || '';
    renderCwdSuggestions(recentCwdList);
    $newModal.classList.add('open');
    setTimeout(() => $nsCwd.focus(), 50);
  }
  function closeNewSessionModal() { $newModal.classList.remove('open'); }

  function renderCwdSuggestions(cwds) {
    $nsCwdSug.innerHTML = '';
    for (const c of cwds) {
      const li = document.createElement('li');
      li.textContent = c;
      li.addEventListener('click', () => { $nsCwd.value = c; });
      $nsCwdSug.appendChild(li);
    }
  }

  async function createNewSession() {
    const cwd = $nsCwd.value.trim();
    if (!cwd) { showToast('请输入工作目录', 'error'); return; }
    const name = $nsName.value.trim();
    // session id assigned by claude on first turn — for now, set cwd + sessionId=null;
    // the label gets attached when we know the id (after first turn).
    if (name) {
      // stash label to be applied after we get a session_init event
      pendingLabel = name;
    }
    startNewSession(cwd);
    closeNewSessionModal();
    $input.focus();
  }

  let pendingLabel = '';
  // when we see session_init in dispatchAgentEvent, if pendingLabel is set, apply it
  const _origDispatch = dispatchAgentEvent;
  /* eslint-disable */
  // override (simple)
  const oldHandler = dispatchAgentEvent;
  // (no-op — handled inline above; we keep pendingLabel via ws.onmessage tap)
  /* eslint-enable */

  // ─── rename modal ─────────────────────────────────────────────
  function openRenameModal(sessionId, currentName) {
    renamingSessionId = sessionId;
    $rnName.value = currentName || '';
    $renameModal.classList.add('open');
    setTimeout(() => $rnName.focus(), 50);
  }
  function closeRenameModal() { $renameModal.classList.remove('open'); renamingSessionId = null; }

  async function saveRename() {
    if (!renamingSessionId) return;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(renamingSessionId)}?token=${encodeURIComponent(TOKEN)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: $rnName.value.trim() || null }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      showToast('已保存', 'ok');
      loadSessions();
      closeRenameModal();
    } catch (e) {
      showToast('保存失败: ' + (e.message || e), 'error');
    }
  }

  // ─── prompt / interrupt ───────────────────────────────────────
  function sendPrompt() {
    const text = $input.value.trim();
    if (!text && pendingImages.length === 0) return;
    if (busy || !ws || ws.readyState !== 1) return;
    const imgs = pendingImages.slice();
    appendUser(text, imgs);
    sendWS({ type: 'prompt', text, images: imgs.length ? imgs : undefined });
    $input.value = '';
    pendingImages = [];
    renderChips();
    autoResize();
    setBusy(true);

    if (pendingLabel) {
      pendingLabelApplyOnSessionInit();
    }
  }

  // ─── image attach ─────────────────────────────────────────────
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const result = String(r.result || '');
        const base64 = result.split(',')[1] || '';
        resolve(base64);
      };
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  function renderChips() {
    $chips.innerHTML = '';
    pendingImages.forEach((img, i) => {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      const thumb = document.createElement('img');
      thumb.src = `data:${img.mediaType};base64,${img.data}`;
      thumb.alt = img.name || 'image';
      const name = document.createElement('span');
      name.className = 'name';
      const baseName = (img.name || 'image').replace(/\.[^.]+$/, '');
      name.textContent = baseName.slice(0, 14);
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'remove';
      x.textContent = '✕';
      x.addEventListener('click', () => {
        pendingImages.splice(i, 1);
        renderChips();
      });
      chip.appendChild(thumb);
      chip.appendChild(name);
      chip.appendChild(x);
      $chips.appendChild(chip);
    });
    // Refresh send button enable state
    $send.disabled = busy || (!$input.value.trim() && pendingImages.length === 0);
  }

  $attachBtn.addEventListener('click', () => {
    log('info', 'attach click');
    $filePicker.click();
  });

  $filePicker.addEventListener('change', async (e) => {
    const target = e.target;
    const files = target && target.files ? Array.from(target.files) : [];
    log('info', `picker change: ${files.length} files (${files.map(f => f.type + '/' + Math.round(f.size/1024) + 'K').join(', ')})`);
    for (const f of files) {
      if (!f.type.startsWith('image/')) {
        showToast(`${f.name} 不是图片`, 'error');
        continue;
      }
      if (f.size > 5 * 1024 * 1024) {
        showToast(`${f.name} 太大 (>5MB)`, 'error');
        continue;
      }
      if (pendingImages.length >= 4) {
        showToast('最多 4 张图', 'error');
        break;
      }
      try {
        const data = await fileToBase64(f);
        const mediaType = (f.type === 'image/jpg' ? 'image/jpeg' : f.type);
        pendingImages.push({ data, mediaType, name: f.name });
      } catch (err) {
        log('error', 'image read fail: ' + (err && err.message || err));
        showToast(`读取 ${f.name} 失败`, 'error');
      }
    }
    renderChips();
    if (target) target.value = '';
  });

  function pendingLabelApplyOnSessionInit() {
    const name = pendingLabel;
    pendingLabel = '';
    const check = () => {
      if (currentSessionId) {
        fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}?token=${encodeURIComponent(TOKEN)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        }).then(() => loadSessions()).catch(() => {});
      } else {
        setTimeout(check, 200);
      }
    };
    setTimeout(check, 300);
  }

  function interrupt() {
    sendWS({ type: 'interrupt' });
    stopSpeak();
  }

  function autoResize() {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, window.innerHeight * 0.38) + 'px';
    $send.disabled = busy || (!$input.value.trim() && pendingImages.length === 0);
  }

  // ─── voice STT ────────────────────────────────────────────────
  let recog = null;
  let recogActive = false;
  let baseText = '';

  function initSTT() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      log('warn', 'SpeechRecognition unavailable');
      $mic.title = '此浏览器不支持语音识别';
      $mic.style.opacity = '0.4';
      return;
    }
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      log('warn', 'non-secure context — SR may fail');
      // don't disable; let user discover and we'll show clear toast
    }
    recog = new SR();
    // Default to zh-CN. Browser UI language is unrelated to what the user
    // speaks (most users here have English Chrome UI but talk Chinese).
    // We can expose a toggle later.
    recog.lang = 'zh-CN';
    recog.interimResults = true;
    recog.continuous = false;
    recog.maxAlternatives = 1;

    recog.onstart = () => {
      recogActive = true;
      $mic.setAttribute('aria-pressed', 'true');
      baseText = $input.value;
      log('ok', 'STT start (lang=' + recog.lang + ')');
    };
    recog.onresult = (ev) => {
      let interim = '', finalT = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalT += r[0].transcript;
        else interim += r[0].transcript;
      }
      const sep = baseText && !/\s$/.test(baseText) ? ' ' : '';
      $input.value = baseText + sep + (finalT || interim);
      autoResize();
    };
    recog.onerror = (ev) => {
      recogActive = false;
      $mic.setAttribute('aria-pressed', 'false');
      const err = ev.error || 'unknown';
      log('error', `STT err: ${err} (secure=${window.isSecureContext})`);
      if (err === 'no-speech') return; // common, don't toast
      // On Android Chrome 94+ the Web Speech API silently fails (often as
      // 'aborted' immediately after start) when the page isn't a secure
      // context. We surface a single actionable hint in that case.
      if (!window.isSecureContext && (err === 'aborted' || err === 'not-allowed' || err === 'service-not-allowed')) {
        showToast(
          '语音需要 HTTPS。Windows PowerShell 跑：tailscale serve --bg https / http://localhost:8765，然后用它给的 .ts.net URL',
          'error', 9000
        );
        return;
      }
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        showToast('麦克风权限被拒，去浏览器设置开启', 'error', 5000);
        return;
      }
      if (err === 'audio-capture') {
        showToast('麦克风设备不可用', 'error', 4000);
        return;
      }
      if (err === 'network') {
        showToast('STT 需联网（Google 语音服务）', 'error', 4000);
        return;
      }
      showToast('STT 错误: ' + err, 'error', 3500);
    };
    recog.onend = () => {
      recogActive = false;
      $mic.setAttribute('aria-pressed', 'false');
      log('info', 'STT end');
    };
  }

  function startSTT() {
    if (!recog) { showToast('此设备不支持语音识别', 'error'); return; }
    if (recogActive) { recog.stop(); return; }
    // CRITICAL: don't await anything before recog.start() — Chrome treats
    // an async gap as breaking the user-gesture chain and the recognition
    // aborts within 1 RAF. The permission query we used to do here was
    // the cause of the immediate 'aborted' error.
    try {
      recog.start();
    } catch (e) {
      log('error', 'STT start fail: ' + (e && e.message || e));
      showToast('语音启动失败: ' + (e && e.message || e), 'error', 4000);
    }
  }

  // ─── voice TTS ────────────────────────────────────────────────
  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const voices = speechSynthesis.getVoices();
    zhVoice = voices.find((v) => /^zh/i.test(v.lang)) || voices[0] || null;
  }
  if ('speechSynthesis' in window) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }
  function stripForTTS(text) {
    return text
      .replace(/```[\s\S]*?```/g, '。代码块。 ')
      .replace(/`[^`\n]+`/g, '')
      .replace(/[#*_>\[\]()~]/g, '')
      .replace(/\n{2,}/g, '。 ')
      .replace(/\n/g, '，')
      .slice(0, 600);
  }
  function speak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    if (zhVoice) u.voice = zhVoice;
    u.lang = (zhVoice && zhVoice.lang) || 'zh-CN';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }
  function stopSpeak() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  // ─── event wiring ─────────────────────────────────────────────
  $input.addEventListener('input', autoResize);
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt();
    }
  });
  $send.addEventListener('click', sendPrompt);
  $stop.addEventListener('click', interrupt);

  $mic.addEventListener('click', startSTT);

  $tts.addEventListener('click', () => {
    ttsOn = !ttsOn;
    $tts.setAttribute('aria-pressed', String(ttsOn));
    $tts.textContent = ttsOn ? '🔊' : '🔈';
    if (!ttsOn) stopSpeak();
    log('info', 'tts ' + (ttsOn ? 'on' : 'off'));
  });

  $debugBtn.addEventListener('click', () => {
    const open = !$debug.classList.contains('open');
    $debug.classList.toggle('open', open);
    $debugBtn.setAttribute('aria-pressed', String(open));
  });

  $autoBtn.addEventListener('click', () => {
    const next = !settings.autoApproveTools;
    sendWS({ type: 'set_settings', autoApproveTools: next });
    // Optimistic — server will broadcast back the canonical state.
    settings.autoApproveTools = next;
    reflectSettings();
    showToast(next ? '已开启 auto 模式：工具调用自动批准' : 'auto 模式已关闭', 'ok', 2500);
  });

  $openDrawer.addEventListener('click', openDrawer);
  $closeDrawer.addEventListener('click', closeDrawer);
  $drawerBd.addEventListener('click', closeDrawer);

  $newSessionBtn.addEventListener('click', openNewSessionModal);
  $nsCreate.addEventListener('click', createNewSession);
  $rnSave.addEventListener('click', saveRename);
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => {
      $newModal.classList.remove('open');
      $renameModal.classList.remove('open');
    });
  });
  $newModal.addEventListener('click', (e) => { if (e.target === $newModal) $newModal.classList.remove('open'); });
  $renameModal.addEventListener('click', (e) => { if (e.target === $renameModal) $renameModal.classList.remove('open'); });

  // On Android Chrome backgrounded PWAs the JS context is frequently frozen
  // and the WebSocket dies — but onclose may not fire (or its reconnect
  // setTimeout doesn't run) until the page becomes visible again. So on
  // visibility-resume we ALWAYS check ws health and force a reconnect.
  let lastHiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      lastHiddenAt = Date.now();
      stopSpeak();
      log('info', 'page hidden');
    } else {
      const awaySec = Math.round((Date.now() - lastHiddenAt) / 1000);
      log('info', `page visible (away ${awaySec}s, ws.readyState=${ws ? ws.readyState : 'null'})`);
      if (!ws || ws.readyState !== 1 /* OPEN */) {
        log('warn', 'ws not open on resume — force reconnect');
        try { ws && ws.close(); } catch {}
        ws = null;
        reconnectAttempts = 0;
        connect();
      }
    }
  });

  // Same idea on pageshow — covers iOS-style bfcache restores too.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      log('info', 'pageshow from bfcache, force reconnect');
      try { ws && ws.close(); } catch {}
      ws = null;
      reconnectAttempts = 0;
      connect();
    }
  });
  // Network coming back online → also reconnect.
  window.addEventListener('online', () => {
    log('info', 'navigator online, force reconnect');
    if (!ws || ws.readyState !== 1) {
      try { ws && ws.close(); } catch {}
      ws = null;
      reconnectAttempts = 0;
      connect();
    }
  });

  // ─── boot ─────────────────────────────────────────────────────
  if (!TOKEN) {
    setStatus('error', '缺 token');
    appendError('URL 缺少 ?token=… 参数。请使用 server 启动时打印的完整地址。');
  } else {
    initSTT();
    connect();
  }
})();
