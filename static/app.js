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

  // ─── token & server base ──────────────────────────────────────
  // Two deployment shapes:
  //   * Browser PWA — index.html served by the user's server, ?token=… in
  //     URL, everything is same-origin so a relative '/api/...' works.
  //   * Capacitor APK — bundled index.html at http://localhost, server URL
  //     and token come from localStorage (set by the bootstrap form or QR
  //     scan in index.html). All fetch / WS calls then need an absolute
  //     base URL pointing at the user's server.
  //
  // getServerBase() returns '' for browser PWA (relative) and the absolute
  // origin like 'http://100.119.115.75:8765' for Capacitor.
  function inCapacitor() { return !!(window.Capacitor || window.cordova); }
  function getServerBase() {
    if (inCapacitor()) {
      const v = localStorage.getItem('agentphone:serverUrl') || '';
      return v.replace(/\/+$/, '');
    }
    return '';  // same-origin in browser PWA
  }
  function getToken() {
    if (inCapacitor()) {
      return localStorage.getItem('agentphone:token') || '';
    }
    return new URL(location.href).searchParams.get('token') || '';
  }
  // TOKEN is captured ONCE at boot so we don't re-read localStorage on every
  // request, but it's recomputed if the bootstrap config completes after
  // initial load (see the agentphone-config-ready event below).
  let TOKEN = getToken();
  // api('/api/foo') yields the full URL for fetch().
  function api(path) {
    return getServerBase() + path;
  }
  function buildWsUrl() {
    const base = getServerBase();
    let host, proto;
    if (base) {
      try {
        const u = new URL(base);
        host = u.host;
        proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      } catch { host = location.host; proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; }
    } else {
      host = location.host;
      proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    }
    let u = `${proto}//${host}/ws?token=${encodeURIComponent(TOKEN)}`;
    if (currentSessionId) u += '&session=' + encodeURIComponent(currentSessionId);
    if (currentCwd)       u += '&cwd=' + encodeURIComponent(currentCwd);
    return u;
  }

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
  const $refreshBtn = document.getElementById('refresh-btn');
  const $autoBtn    = document.getElementById('auto-toggle');
  const $effortChip = document.getElementById('effort-chip');
  const $effortMenu = document.getElementById('effort-menu');
  const $effortBd   = document.getElementById('effort-menu-bd');
  const $debugBtn   = document.getElementById('debug-toggle');
  const $bannerRow  = document.getElementById('banner-row');
  const $searchBox  = document.getElementById('session-search');
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
  let lastTurnId = null;       // server-assigned turn id of the most recent agent_event we rendered
  let lastRenderedSeq = -1;    // max seq we've already applied to the DOM for that turn
  let lastEventAt = 0;         // wall-clock of most recent agent_event while busy=true
  let busyWatchdog = null;     // setTimeout handle
  /** @type {{pid:number,account:string,kind:string,status:'idle'|'busy'} | null} */
  let currentExternal = null;  // external (CLI/bg) status of currentSessionId
  let followModeTakenOver = false; // user clicked 接管 — temporarily allow send
  // v19: follow-mode is now event-pushed by the server jsonl-watcher.
  // lastHistoryTotal is kept for fetchAndRenderHistory's no-op skip path
  // (called once on first load).
  let lastHistoryTotal = -1;
  /** @type {Array<{ data: string, mediaType: string, name?: string }>} */
  let pendingImages = [];
  /** @type {{ autoApproveTools: boolean, effort: string }} */
  let settings = { autoApproveTools: false, effort: 'max', version: 0 };

  function reflectSettings() {
    $autoBtn.setAttribute('aria-pressed', String(settings.autoApproveTools));
    $autoBtn.title = settings.autoApproveTools
      ? '自动批准工具调用 (yolo) — 已开 · 点击关闭'
      : '自动批准工具调用 (yolo) — 关 · 点击开启';
    // effort chip
    if ($effortChip) {
      $effortChip.textContent = settings.effort || 'max';
      $effortChip.classList.toggle('is-max', settings.effort === 'max');
    }
    if ($effortMenu) {
      $effortMenu.querySelectorAll('li').forEach((li) => {
        li.classList.toggle('is-active', li.getAttribute('data-effort') === settings.effort);
      });
    }
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

  // Streaming-safe wrapper: splits the in-progress text at the LAST
  // paragraph break (\n\n). Everything before is "stable" — by definition
  // no partial table / open code fence / unclosed bold can survive a
  // paragraph boundary — so we send it through marked normally. Everything
  // after is the in-progress tail rendered as escaped plaintext so
  // half-formed pipe rows / open ``` / unclosed inline `code` don't get
  // mangled into ugly HTML during streaming. block_end calls renderMarkdown
  // directly on the full content for the final clean render.
  function renderMarkdownStream(text) {
    const lastBreak = text.lastIndexOf('\n\n');
    if (lastBreak < 0) {
      return `<div class="stream-tail">${escapeHtml(text)}</div>`;
    }
    const safe = text.slice(0, lastBreak);
    const tail = text.slice(lastBreak + 2);
    const safeHtml = renderMarkdown(safe);
    const tailHtml = tail.trim()
      ? `\n<div class="stream-tail">${escapeHtml(tail)}</div>`
      : '';
    return safeHtml + tailHtml;
  }

  function renderMarkdown(text) {
    if (!window.marked) return `<pre>${escapeHtml(text)}</pre>`;
    try {
      // breaks:true → single newline becomes <br>. Chat content is much more
      // readable that way; the strict-markdown default of "single \n = space"
      // makes the assistant's paragraphs run together. CLI cmax effectively
      // does the same by streaming char-by-char.
      let html = window.marked.parse(text, { gfm: true, breaks: true, async: false });
      html = html.replace(/<table>/g, '<div class="table-wrap"><table>')
                 .replace(/<\/table>/g, '</table></div>');
      // #2 Inject a copy button into every <pre> so phone users don't have
      // to hold-select code blocks. We use a unique attribute marker so
      // the click handler can find them.
      html = html.replace(/<pre>/g, '<pre><button type="button" class="pre-copy" aria-label="复制">📋</button>');
      return html;
    } catch {
      return `<pre>${escapeHtml(text)}</pre>`;
    }
  }

  // Delegated copy: whole assistant message via the 📋 in the msg header.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains('msg-copy')) return;
    const msg = t.closest('.msg');
    if (!msg) return;
    const body = msg.querySelector('.body');
    if (!body) return;
    const text = body.innerText || body.textContent || '';
    const flash = () => {
      t.classList.add('copied');
      t.textContent = '✓';
      setTimeout(() => { t.classList.remove('copied'); t.textContent = '📋'; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => {
        showToast('复制失败 — 浏览器不支持？', 'error', 2500);
      });
    }
    e.stopPropagation();
  });

  // Delegated click handler for copy buttons (works for both live + replay).
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains('pre-copy')) return;
    const pre = t.closest('pre');
    if (!pre) return;
    const code = pre.querySelector('code');
    const text = (code ? code.textContent : pre.textContent) || '';
    const flash = () => {
      t.classList.add('copied');
      t.textContent = '✓';
      setTimeout(() => { t.classList.remove('copied'); t.textContent = '📋'; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => {
        showToast('复制失败 — 浏览器不支持？', 'error', 2500);
      });
    } else {
      // very old fallback
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        flash();
      } catch {
        showToast('复制失败', 'error', 2500);
      }
    }
    e.stopPropagation();
  });
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
    const followBlocked = isFollowBlocked();
    $send.disabled = busy || followBlocked || (!$input.value.trim() && pendingImages.length === 0);
    $stop.classList.toggle('hidden', !busy);
    $send.classList.toggle('hidden', busy);
    if (busy) {
      setStatus('busy', '思考中');
      lastEventAt = Date.now();
      armBusyWatchdog();
    } else if (followBlocked) {
      setStatus('connected', '👀 CLI 思考中');
    } else {
      setStatus(ws && ws.readyState === 1 ? 'connected' : '', ws && ws.readyState === 1 ? '已连接' : '断开');
      if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
    }
  }

  // True whenever an external claude.exe (CLI / bg) owns the current session
  // AND the user hasn't switched to inject mode. Inject mode unlocks the
  // composer so the user can append a message to the external jsonl directly
  // (β path) — cmax sees it as queued user input.
  function isFollowBlocked() {
    return !!currentExternal && !injectMode;
  }

  // Inject mode: phone is on an externally-owned session and the user wants
  // to drop a message into CLI's queue rather than just watch. Toggled by
  // the 📤 button in the follow banner.
  let injectMode = false;
  // Link badge: phone-owned session that's mirroring to a CLI session A.
  // Server pushes link_info after select_session or after the user clicks
  // the 🔀 fork button.
  let currentLinkExternalSid = null;

  // Follow-mode used to poll /api/sessions/:id/messages every 4s while the
  // external driver was busy. Since v19 the server pushes live events from
  // a jsonl-tail watcher (server/harness/cmax-external/jsonl-watcher.ts) as
  // regular agent_event messages, so no client poll is needed — these
  // helpers became no-ops and stay only so callers can keep their existing
  // start/stop sequencing without conditionals.
  function startFollowRefresh() { /* server pushes via watcher */ }
  function stopFollowRefresh()  { /* nothing to stop */ }

  /** Reflect currentExternal + currentLinkExternalSid into UI. */
  function applyFollowMode() {
    if ($bannerRow) {
      const old = $bannerRow.querySelector('.banner.follow-mode');
      if (old) old.remove();
      const oldLink = $bannerRow.querySelector('.banner.link-mode');
      if (oldLink) oldLink.remove();
    }

    // CASE 1: phone-owned session linked to an external CLI session — show
    // a small "📎 mirroring to cmax/xxxx" badge banner, composer normal.
    if (!currentExternal && currentLinkExternalSid) {
      $input.placeholder = '问 claude…';
      addLinkBanner();
      stopFollowRefresh();
      setBusy(busy);
      return;
    }

    // CASE 2: no external owner, no link → vanilla mode.
    if (!currentExternal) {
      $input.placeholder = '问 claude…';
      injectMode = false;
      stopFollowRefresh();
      setBusy(busy);
      return;
    }

    // CASE 3: external owner present.
    const ext = currentExternal;
    if (ext.status === 'busy') startFollowRefresh(); else stopFollowRefresh();

    if (injectMode) {
      $input.placeholder = `📤 注入到 ${ext.account} CLI queue · 桌面按 Enter 才真的发`;
      const html = `📤 <b>inject mode</b> — 输入的消息会**写到 cmax 的 queue**。` +
                   ` 同一份 session, 0 race。但需要桌面 CLI 按 Enter 才真的触发响应。` +
                   ` <button type="button" class="follow-cancel-inject">退出 inject</button>`;
      addFollowBanner(html);
    } else {
      $input.placeholder = `🔒 ${ext.account} CLI 拥有此 session · 选择行动 →`;
      const verb = ext.status === 'busy' ? '正在思考' : 'idle';
      const html = `👀 <b>follow mode</b> — <code>${ext.account}</code> 的 ${ext.kind} CLI ` +
                   `(<code>pid ${ext.pid}</code>) ${verb}。` +
                   ` 选择: ` +
                   ` <button type="button" class="follow-inject">📤 注入到 CLI</button>` +
                   ` <button type="button" class="follow-fork">🔀 fork 新 session</button>`;
      addFollowBanner(html);
    }
    setBusy(busy);
  }

  function addLinkBanner() {
    if (!$bannerRow) return;
    const b = document.createElement('div');
    b.className = 'banner info link-mode';
    const sid = currentLinkExternalSid ?? '';
    b.innerHTML =
      `📎 <b>linked</b> — 每个 turn 自动 mirror 到 cmax ` +
      `<code>${sid.slice(0, 8)}</code> (摘要, 不进 API context)。 ` +
      `<button type="button" class="link-merge">🔗 合并整段到 CLI</button>` +
      ` <button type="button" class="link-unlink">✕ 取消 link</button>` +
      ` <button class="x" type="button" aria-label="dismiss">✕</button>`;
    b.querySelector('.x').addEventListener('click', () => b.remove());
    const unlinkBtn = b.querySelector('.link-unlink');
    if (unlinkBtn) {
      unlinkBtn.addEventListener('click', () => {
        if (!currentSessionId) return;
        sendWS({ type: 'set_link', phoneSessionId: currentSessionId, externalSessionId: null });
        // server will echo link_info with null; for snappier UI clear locally
        currentLinkExternalSid = null;
        applyFollowMode();
        showToast('已取消 mirror link', 'ok', 1500);
      });
    }
    const mergeBtn = b.querySelector('.link-merge');
    if (mergeBtn) {
      mergeBtn.addEventListener('click', () => {
        if (!currentSessionId || !currentLinkExternalSid) return;
        if (!confirm('把此手机 session 的整段对话作为一条 user message 注入到 CLI session 的 queue？\n\n桌面 CLI 需要按 Enter 才会让 claude 真正消费它当作 context。')) return;
        sendWS({
          type: 'merge_to_external',
          phoneSessionId: currentSessionId,
          externalSessionId: currentLinkExternalSid,
        });
        showToast('合并请求已发送 · 见桌面 CLI', 'ok', 2200);
      });
    }
    $bannerRow.appendChild(b);
  }

  function addFollowBanner(html) {
    if (!$bannerRow) return;
    const b = document.createElement('div');
    b.className = 'banner warn follow-mode';
    b.innerHTML = html + ' <button class="x" type="button" aria-label="dismiss">✕</button>';
    b.querySelector('.x').addEventListener('click', () => b.remove());

    const injectBtn = b.querySelector('.follow-inject');
    if (injectBtn) {
      injectBtn.addEventListener('click', () => {
        injectMode = true;
        applyFollowMode();
        $input.focus();
        showToast('inject 模式 · 内容会写到 CLI queue', 'ok', 1800);
      });
    }
    const cancelInjectBtn = b.querySelector('.follow-cancel-inject');
    if (cancelInjectBtn) {
      cancelInjectBtn.addEventListener('click', () => {
        injectMode = false;
        applyFollowMode();
      });
    }
    const forkBtn = b.querySelector('.follow-fork');
    if (forkBtn) {
      forkBtn.addEventListener('click', () => {
        // Server-side fork-with-history: it reads A's jsonl, stashes the
        // history block as a prefix to our next prompt, spawns a fresh
        // pending runner (B), and auto-links B → A on session_init. We
        // skip the new-session modal entirely — fork-with-history keeps
        // A's cwd by default, since the whole point is "continue this
        // conversation".
        if (!currentSessionId) return;
        sendWS({ type: 'fork_session', externalSessionId: currentSessionId, cwd: currentCwd });
        clearMessages();
        // Local optimistic state: server will echo session_set { sessionId:
        // null } back; applyFollowMode will hide the external banner.
        currentSessionId = null;
        currentExternal = null;
        applyFollowMode();
        closeDrawer();
        showToast('fork 中 · 历史会作为下一条 prompt 的前缀注入', 'ok', 2400);
        setTimeout(() => { try { $input?.focus(); } catch {} }, 100);
      });
    }
    $bannerRow.appendChild(b);
  }

  // Set when user clicked "🔀 fork" — used to auto-issue set_link as soon as
  // the new session_init lands.
  let pendingForkLinkTo = null;

  // If busy for 90s with no incoming agent_event the agent is likely stuck
  // (or our WS heartbeat fix already reconnected but no events came). Offer
  // the user a "force-clear" button instead of staring at 思考中 forever.
  function armBusyWatchdog() {
    if (busyWatchdog) clearTimeout(busyWatchdog);
    busyWatchdog = setTimeout(() => {
      if (!busy) return;
      const silentSec = Math.round((Date.now() - lastEventAt) / 1000);
      if (silentSec < 90) { armBusyWatchdog(); return; }  // events came in between
      log('warn', `busy watchdog: ${silentSec}s without events`);
      if (typeof addBanner === 'function') {
        // Drop a one-shot banner with two actions
        const html = `⚠ 「思考中」已持续 ${silentSec}s 没新动静。` +
                     `<button class="banner-act" id="bw-reset">强制清除</button>` +
                     `<button class="banner-act" id="bw-interrupt">让 server 打断</button>`;
        addBanner('warn', html);
        const reset = document.getElementById('bw-reset');
        const intr  = document.getElementById('bw-interrupt');
        if (reset) reset.addEventListener('click', () => {
          setBusy(false);
          showToast('已强制清除 busy', 'ok', 1800);
          const b = reset.closest('.banner'); if (b) b.remove();
        });
        if (intr) intr.addEventListener('click', () => {
          sendWS({ type: 'interrupt' });
          showToast('已发送 interrupt', 'ok', 1800);
          const b = intr.closest('.banner'); if (b) b.remove();
        });
      }
    }, 91_000);
  }

  // Auto-scroll respects the user: if they've actively scrolled up to read,
  // we don't yank them back to the bottom mid-stream. Two-tier check:
  //   * "near bottom" threshold bumped from 80 → 200px so a small scroll-up
  //     while reading doesn't get clobbered
  //   * an explicit userScrolledAway flag set by the messages-area scroll
  //     listener — once the user puts >200px between themselves and the
  //     bottom, we stop auto-scrolling entirely until they scroll back into
  //     the live zone or the next user message resets it.
  let userScrolledAway = false;
  function autoScroll() {
    if (userScrolledAway) return;
    const m = $messages;
    const distFromBottom = m.scrollHeight - m.scrollTop - m.clientHeight;
    if (distFromBottom < 200) m.scrollTop = m.scrollHeight;
  }
  if ($messages) {
    $messages.addEventListener('scroll', () => {
      const m = $messages;
      const distFromBottom = m.scrollHeight - m.scrollTop - m.clientHeight;
      // If user scrolled into the live zone, re-enable auto-scroll. Otherwise
      // (they walked away from the bottom), suppress auto-scroll.
      userScrolledAway = distFromBottom > 240;
    }, { passive: true });
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
      $hAcct.title = `claude account: ${name} · 点查看可用 accounts`;
    }
  }

  // Tap the account pill → show a quick info modal listing every account
  // we found under ~/.claude-accounts/, marking the active one. v1 is
  // read-only; switching at runtime is a TODO so we just educate the
  // user about how to change it.
  if ($hAcct) {
    $hAcct.addEventListener('click', async () => {
      try {
        const r = await fetch(api(`/api/accounts?token=${encodeURIComponent(TOKEN)}`));
        if (!r.ok) { showToast('account 列表拉失败 HTTP ' + r.status, 'error'); return; }
        const j = await r.json();
        const lines = (j.accounts || []).map((a) =>
          `${a.active ? '●' : '○'} ${a.name}`
        );
        const body =
          'agentphone 检测到以下 claude account（在 ~/.claude-accounts/）：\n\n' +
          lines.join('\n') +
          '\n\n● = 当前使用\n○ = 可切换\n\n切换方法（暂时还要重启 server）：\n' +
          '1. 编辑 ~/.config/agentphone/env\n' +
          '2. 加一行: CLAUDE_CONFIG_DIR=/home/yzt/.claude-accounts/<name>\n' +
          '3. systemctl --user restart agentphone\n\n' +
          '运行时无重启切换 = P1 TODO，做了告诉你';
        alert(body);
      } catch (e) {
        showToast('account 列表拉失败: ' + (e && e.message || e), 'error');
      }
    });
    $hAcct.style.cursor = 'pointer';
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
    msg.appendChild(who);
    // Whole-message copy button for assistant blocks — code-block copy
    // already exists, but folks often want to grab the whole reply too.
    // Thinking blocks skip this (it's internal scratch, not the response).
    if (wantClass === 'assistant') {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'msg-copy';
      copyBtn.title = '复制整条回复';
      copyBtn.setAttribute('aria-label', '复制整条回复');
      copyBtn.textContent = '📋';
      msg.appendChild(copyBtn);
    }
    const body = document.createElement('div');
    body.className = 'body';
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
    // Per-(message, kind) merging — NOT per block. Claude often splits a
    // single response across several content blocks of the same kind (e.g.
    // text → tool_use → text). Each block then gets its own mblock and a
    // separate marked() parse, so a markdown table or fenced code span
    // straddling two text blocks can't be recognized in either piece —
    // tables render as raw "| a | b |" rows, code fences as inline ticks,
    // etc. Refreshing rebuilt the assistant message from the history API
    // (which serves one concatenated text) and everything came out clean —
    // that's the screenshot diff the user flagged.
    //
    // Fix: same key for every text block of the same message, same for
    // thinking. Multiple deltas accumulate in one rawText; one marked()
    // call sees the full content and parses it correctly.
    const key = `${evt.messageId}:${evt.blockType}`;
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
    // #3: bumped from 100ms → 200ms — long replies (multi-KB markdown +
    // hljs) were burning CPU on every token; 200ms is still smooth and
    // gives ~5 renders/sec instead of 10.
    const elapsed = Date.now() - state.lastRender;
    const wait = elapsed < 200 ? 200 - elapsed : 0;
    setTimeout(() => {
      state.pendingRender = false;
      state.lastRender = Date.now();
      if (state.kind === 'thinking') {
        state.el.textContent = state.rawText;
      } else {
        // Streaming-safe render — incomplete trailing block stays as
        // plaintext so we don't get the "raw |column| rows" / "open ```"
        // visual glitches between deltas. block_end runs the full
        // renderMarkdown on the same rawText so the final state is clean.
        state.el.innerHTML = renderMarkdownStream(state.rawText);
        highlightInside(state.el);
      }
      autoScroll();
    }, wait);
  }

  function onTextDelta(evt) {
    const key = `${evt.messageId}:text`;
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
    const key = `${evt.messageId}:thinking`;
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
    // Multiple text/thinking blocks of one message all map to the same
    // streamState entry (messageId:text / messageId:thinking). We still get
    // one block_end per content block, but the render is correct after
    // ANY of them (marked sees the latest accumulated rawText). The hljs
    // call here ensures the final state is fully styled.
    const tKey = `${evt.messageId}:text`;
    const sText = streamState.get(tKey);
    if (sText) {
      sText.el.innerHTML = renderMarkdown(sText.rawText);
      highlightInside(sText.el);
      if (ttsOn) speak(stripForTTS(sText.rawText));
    }
    const kKey = `${evt.messageId}:thinking`;
    const sThink = streamState.get(kKey);
    if (sThink) {
      sThink.el.textContent = sThink.rawText;
    }
    autoScroll();
    // We do NOT delete streamState entries here — the merging design keeps
    // them alive across blocks of the same message so subsequent text
    // blocks of the same message accumulate into the same mblock. The
    // entries become unreferenced naturally when the next user prompt
    // starts a new message and clearMessages → streamState.clear() runs.
  }

  // ─── user message ─────────────────────────────────────────────
  function appendUser(text, images) {
    clearEmpty();
    // User just spoke — they almost certainly want to see the upcoming reply,
    // so reset the "I'm reading history" flag.
    userScrolledAway = false;
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

      // #5: per-tool "永久 auto" checkbox — persists across turns
      const labelForever = document.createElement('label');
      const cbForever = document.createElement('input');
      cbForever.type = 'checkbox';
      const lt2 = document.createElement('span');
      lt2.textContent = `以后 ${toolName} 自动 approve`;
      labelForever.appendChild(cbForever);
      labelForever.appendChild(lt2);

      allowBtn.addEventListener('click', () => {
        if (cbForever.checked) {
          // persist server-side via settings
          const update = {};
          update[toolName] = true;
          sendWS({ type: 'set_settings', perToolAuto: update, expectedVersion: settings.version });
        }
        sendWS({ type: 'tool_response', toolUseId, decision: 'allow', allowRestOfTurn: cb.checked });
        markToolResolved(toolUseId, 'allow');
      });
      denyBtn.addEventListener('click', () => {
        sendWS({ type: 'tool_response', toolUseId, decision: 'deny' });
        markToolResolved(toolUseId, 'deny');
      });

      approveBox.appendChild(labelAll);
      approveBox.appendChild(labelForever);
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

  function appendContextFullCard(rawMsg) {
    clearEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'msg error context-full';
    const who = document.createElement('div'); who.className = 'who'; who.textContent = '上下文已满';
    const body = document.createElement('div'); body.className = 'body';
    const lead = document.createElement('p');
    lead.style.margin = '0 0 8px';
    lead.textContent = '这个 session 的 context window 用满了。两个出路:';
    const acts = document.createElement('div');
    acts.className = 'cf-actions';
    const compactBtn = document.createElement('button');
    compactBtn.className = 'tool-btn allow';
    compactBtn.textContent = '⚡ 压缩此 session';
    const newBtn = document.createElement('button');
    newBtn.className = 'tool-btn';
    newBtn.textContent = '+ 新建 session';
    const hint = document.createElement('p');
    hint.className = 'cf-hint';
    hint.textContent = '压缩 = 让 agent 把当前对话浓缩成摘要后继续。新建 = 完全重启。';
    acts.appendChild(compactBtn);
    acts.appendChild(newBtn);
    body.appendChild(lead);
    body.appendChild(acts);
    body.appendChild(hint);
    if (rawMsg) {
      const raw = document.createElement('details');
      const sum = document.createElement('summary');
      sum.style.cursor = 'pointer';
      sum.style.fontSize = '11px';
      sum.style.color = 'var(--muted)';
      sum.textContent = '原始 SDK 错误';
      const pre = document.createElement('pre');
      pre.style.fontSize = '11px';
      pre.style.color = 'var(--muted)';
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = String(rawMsg);
      raw.appendChild(sum);
      raw.appendChild(pre);
      body.appendChild(raw);
    }
    wrap.appendChild(who);
    wrap.appendChild(body);
    $messages.appendChild(wrap);
    autoScroll();

    compactBtn.addEventListener('click', () => {
      sendWS({ type: 'prompt', text: '/compact' });
      setBusy(true);
      compactBtn.disabled = true;
      newBtn.disabled = true;
      compactBtn.textContent = '正在压缩...';
    });
    newBtn.addEventListener('click', () => {
      sendWS({ type: 'select_session', sessionId: null });
      clearMessages();
      showToast('已创建新 session', 'ok', 1500);
    });
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
        fireDoneNotification(evt);
        return appendResult(evt);
      case 'external_user_prompt':
        // Emitted by the cmax-external jsonl-watcher when a new user
        // message lands in a session driven by another claude.exe.
        // Render as a regular user message so follow-mode shows CLI
        // input the moment it's written.
        return appendUser(evt.text, evt.images);
    }
  }

  // ─── WebSocket ────────────────────────────────────────────────
  function sendWS(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // Track when we last heard *anything* from the server. Heartbeat ping
  // counts as activity. If we go 65s with no message at all, the WS is
  // effectively dead even if it shows readyState=OPEN — force reconnect.
  let lastServerActivityAt = Date.now();
  let serverWatchdog = null;
  function armServerWatchdog() {
    if (serverWatchdog) clearInterval(serverWatchdog);
    serverWatchdog = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      const since = Date.now() - lastServerActivityAt;
      if (since > 65_000) {
        log('warn', 'server silent for ' + Math.round(since/1000) + 's — force reconnect');
        connect('watchdog');
      }
    }, 10_000);
  }
  armServerWatchdog();

  let reconnectTimer = null;

  function connect(reason) {
    // Cancel any pending backoff timer — otherwise foreground-resume +
    // pending onclose-backoff both fire connect() and we leak sockets.
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Forcibly close any previous socket BEFORE creating a new one. Without
    // this the previous WS' onmessage handler stays alive and processes
    // events in parallel with the new connection — each event ends up
    // rendered N times where N is the number of leaked sockets. Common
    // trigger: backgrounding the phone fires visibilitychange→reconnect
    // before the OS-killed socket fired onclose.
    if (ws) {
      try {
        ws.onopen = null; ws.onmessage = null;
        ws.onclose = null; ws.onerror = null;
        ws.close();
      } catch (e) {}
      ws = null;
    }

    setStatus('', '连接中');
    log('info', 'ws connecting (reason=' + (reason || 'initial') + ')');
    let myWs;
    try {
      myWs = new WebSocket(buildWsUrl());
    } catch (e) {
      setStatus('error', '无法连接');
      log('error', 'ws ctor: ' + (e && e.message || e));
      return;
    }
    ws = myWs;

    // Each handler bails if it's been replaced — belt-and-suspenders.
    const stale = () => myWs !== ws;

    myWs.onopen = () => {
      if (stale()) return;
      reconnectAttempts = 0;
      setStatus('connected', '已连接');
      log('ok', 'ws open');
    };

    myWs.onmessage = (ev) => {
      if (stale()) return;
      // Any byte from server counts as proof-of-life — keeps watchdog quiet.
      lastServerActivityAt = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      // Reply to server heartbeat ping immediately so it doesn't close us
      // with code 4002 after PONG_TIMEOUT_MS (60s).
      if (m.type === 'ping') {
        try { ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'pong', ts: m.ts })); } catch {}
        return;
      }
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
            const sameTurn = lastTurnId === m.activeTurn.turnId;
            if (!sameTurn) {
              // First sight of this turn (initial connect or different turn
              // since last connection) — full replay.
              clearMessages();
              lastTurnId = m.activeTurn.turnId;
              lastRenderedSeq = -1;
            }
            let appended = 0;
            for (const se of m.activeTurn.events) {
              if (se && typeof se.seq === 'number' && se.seq <= lastRenderedSeq) continue;
              dispatchAgentEvent(se.event);
              if (typeof se.seq === 'number') lastRenderedSeq = Math.max(lastRenderedSeq, se.seq);
              appended++;
            }
            const sec = Math.max(1, Math.round((Date.now() - m.activeTurn.startedAt) / 1000));
            const sep = document.createElement('div');
            sep.className = 'history-sep';
            sep.textContent = !sameTurn
              ? (m.activeTurn.done
                  ? `── 已恢复 ${m.activeTurn.events.length} 条事件（${sec}s 前完成）──`
                  : `── 已恢复 ${m.activeTurn.events.length} 条事件（${sec}s 前开始 · server 还在跑）──`)
              : `── 补齐 ${appended} 条新事件（断开 ${sec}s, 共 ${lastRenderedSeq+1} 条）──`;
            $messages.appendChild(sep);
            setBusy(!m.activeTurn.done);
            showToast(
              !sameTurn ? (m.activeTurn.done ? '已恢复（已完成）' : '已恢复进行中的对话')
                        : `补齐 ${appended} 条`,
              'ok', 2200
            );
          } else {
            // Safety: clear any stale busy state from before disconnect.
            setBusy(false);
            // No active turn replay happened — but if we landed on an
            // existing session and the chat area is empty, pull history so
            // the user doesn't see a blank screen. Without this the first
            // connect renders nothing and the conversation only fills in
            // after a manual refresh or some other trigger (the cause of
            // the "刚开始的渲染有问题，重连后又恢复了" UX bug).
            if (currentSessionId && $messages && !$messages.querySelector('.msg')) {
              fetchAndRenderHistory(currentSessionId).catch(() => {});
            }
          }
          // External-driver status for current session (drives follow-mode UI).
          currentExternal = m.external || null;
          followModeTakenOver = false;  // fresh connect clears takeover
          applyFollowMode();
          loadSessions();
          loadRecentCwds();
          break;
        case 'session_set':
          currentSessionId = m.sessionId;
          setCwdDisplay(m.cwd);
          currentExternal = m.external || null;
          followModeTakenOver = false;
          // Switching sessions wipes the link badge until server sends a
          // fresh link_info for the new session (if any).
          currentLinkExternalSid = null;
          // If the user just clicked "🔀 fork" we stashed the source external
          // sid in pendingForkLinkTo. The new session was just born — issue
          // set_link now to wire B → A.
          if (pendingForkLinkTo && m.sessionId) {
            sendWS({ type: 'set_link', phoneSessionId: m.sessionId, externalSessionId: pendingForkLinkTo });
            // (don't clear yet — wait for the link_info echo, which will set
            //  currentLinkExternalSid; we just clear pendingForkLinkTo below)
            pendingForkLinkTo = null;
          }
          applyFollowMode();
          log('info', 'session set ' + (m.sessionId ? m.sessionId.slice(0,8) : '(new)') + ' cwd=' + m.cwd);
          break;
        case 'link_info':
          // Echo from server after set_link (or surfaced on initial connect).
          if (m.phoneSessionId === currentSessionId) {
            currentLinkExternalSid = m.externalSessionId || null;
            applyFollowMode();
          }
          break;
        case 'external_status': {
          // Update the drawer entry without a full refetch.
          for (const s of allSessions) {
            if (s.sessionId === m.sessionId) {
              s.external = m.external;
              break;
            }
          }
          applySessionFilter();   // re-render with new dot
          // If it's the CURRENTLY selected session, also flip our banner.
          if (m.sessionId === currentSessionId) {
            const wasBusy = currentExternal?.status === 'busy';
            const isBusy = m.external?.status === 'busy';
            currentExternal = m.external;
            // If CLI just finished a turn (busy→idle), refresh history so we
            // see what it produced.
            if (wasBusy && !isBusy && currentSessionId) {
              clearMessages();
              fetchAndRenderHistory(currentSessionId).catch(() => {});
            }
            applyFollowMode();
          }
          break;
        }
        case 'agent_event':
          lastEventAt = Date.now();
          if (m.turnId && m.turnId !== lastTurnId) {
            // Server started a new turn since we last rendered — reset.
            lastTurnId = m.turnId;
            lastRenderedSeq = -1;
          }
          if (typeof m.seq === 'number') {
            if (m.seq <= lastRenderedSeq) break;  // dedup
            lastRenderedSeq = m.seq;
          }
          dispatchAgentEvent(m.event);
          break;
        case 'turn_done':
          setBusy(false);
          // reload sessions to update list (current session moved to top)
          loadSessions();
          break;
        case 'error':
          setBusy(false);
          log('error', m.message);
          if (/context\s*limit|too\s*long|maximum.*context|compact.*continue|ede_diagnostic|result_type=user|stop_reason=null/i.test(m.message || '')) {
            appendContextFullCard(m.message);
          } else {
            appendError(m.message);
            showToast(m.message, 'error', 3500);
          }
          break;
        case 'unauthorized':
          setStatus('error', 'token 错误');
          appendError('URL 里的 token 不对');
          log('error', 'unauthorized');
          break;
        case 'settings':
          settings = m.settings;
          reflectSettings();
          log('info', `settings v${settings.version}: auto=${settings.autoApproveTools} effort=${settings.effort}`);
          break;
        case 'settings_conflict':
          // Another client beat us to a settings update — adopt the
          // server's current value (with bumped version) and reflect into
          // the UI. The user can re-issue their click if they really want.
          settings = m.current;
          reflectSettings();
          log('warn', `settings conflict — rebased to v${settings.version}`);
          showToast('另一端已更新设置，已同步', 'warn', 1800);
          break;
      }
    };

    myWs.onclose = (ev) => {
      if (stale()) return;
      if (ev.code === 4001) { setStatus('error', '未授权'); return; }
      setStatus('error', '断开,重连中');
      setBusy(false);
      log('warn', `ws closed code=${ev.code} reason=${ev.reason || '-'} wasClean=${ev.wasClean}`);
      const wait = Math.min(8000, 500 * (1 + reconnectAttempts++));
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect('backoff'); }, wait);
    };
    myWs.onerror = () => {
      if (stale()) return;
      log('error', `ws error (readyState=${myWs.readyState} online=${navigator.onLine})`);
    };
  }

  // ─── sessions REST ────────────────────────────────────────────
  let recentCwdList = [];

  async function loadSessions() {
    try {
      const r = await fetch(api(`/api/sessions?token=${encodeURIComponent(TOKEN)}`));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const sessions = await r.json();
      renderSessionList(sessions);
    } catch (e) {
      log('error', 'load sessions: ' + (e.message || e));
    }
  }

  async function loadRecentCwds() {
    try {
      const r = await fetch(api(`/api/recent-cwds?token=${encodeURIComponent(TOKEN)}`));
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

  let allSessions = [];

  function renderSessionList(sessions) {
    allSessions = sessions || [];
    applySessionFilter();
  }

  function applySessionFilter() {
    const q = ($searchBox ? $searchBox.value : '').trim().toLowerCase();
    const filtered = q
      ? allSessions.filter((s) => {
          const hay = `${s.name || ''} ${s.cwd || ''} ${s.preview || ''} ${s.sessionId || ''}`.toLowerCase();
          return hay.includes(q);
        })
      : allSessions;
    drawSessionRows(filtered);
  }

  function drawSessionRows(sessions) {
    if (!sessions.length) {
      $sessionList.innerHTML = `<div class="empty" style="padding:24px 16px;font-size:12px;">${allSessions.length ? '无匹配 session' : '还没有 session<br><span style="opacity:.65;">点 "+ 新建"</span>'}</div>`;
      return;
    }
    $sessionList.innerHTML = '';
    for (const s of sessions) {
      const div = document.createElement('div');
      const extBusy = s.external?.status === 'busy';
      const extIdle = s.external?.status === 'idle';
      div.className = 'session-item'
        + (s.sessionId === currentSessionId ? ' active' : '')
        + (s.running ? ' running' : '')
        + (extBusy ? ' ext-busy' : extIdle ? ' ext-idle' : '');
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
      if (s.external) {
        const extDot = document.createElement('span');
        extDot.className = 'ext-dot ext-dot-' + s.external.status;
        extDot.title = `${s.external.account} CLI · ${s.external.status}`;
        extDot.textContent = s.external.status === 'busy' ? '● thinking' : '● live';
        name.appendChild(extDot);
      }

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
          const r = await fetch(api(`/api/sessions/${encodeURIComponent(s.sessionId)}?token=${encodeURIComponent(TOKEN)}`), { method: 'DELETE' });
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

  async function fetchAndRenderHistory(sessionId, opts) {
    const silent = !!(opts && opts.silent);
    const skipIfUnchanged = !!(opts && opts.skipIfUnchanged);
    let placeholder = null;
    if (!silent) {
      placeholder = document.createElement('div');
      placeholder.className = 'history-sep loading';
      placeholder.textContent = '── 加载历史… ──';
      $messages.appendChild(placeholder);
      autoScroll();
    }

    try {
      const r = await fetch(api(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages` +
        `?token=${encodeURIComponent(TOKEN)}&limit=30`
      ));
      if (!r.ok) {
        if (placeholder) {
          placeholder.textContent = `── 加载历史失败 (HTTP ${r.status}) ──`;
          placeholder.classList.add('err');
        }
        return;
      }
      const data = await r.json();
      const msgs = data.messages || [];
      // Silent-poll bail-out: if the API's total event count hasn't grown
      // since our last fetch for this session, the jsonl hasn't changed —
      // skip re-rendering to avoid flicker.
      if (skipIfUnchanged && typeof data.total === 'number' && data.total === lastHistoryTotal) {
        if (placeholder) placeholder.remove();
        return;
      }
      if (typeof data.total === 'number') lastHistoryTotal = data.total;
      // For silent re-renders we replace the existing content so the user
      // sees fresh history; otherwise the original behaviour (append only)
      // stays for first-load.
      // Capture scroll state BEFORE clearing so we can restore it after the
      // re-render (silent path only — first-load wants bottom).
      const prevScrollTop    = $messages.scrollTop;
      const prevScrollHeight = $messages.scrollHeight;
      const prevClientHeight = $messages.clientHeight;
      const wasAtBottom =
        (prevScrollHeight - prevScrollTop - prevClientHeight) < 80;
      if (silent) clearMessages();
      if (placeholder) placeholder.remove();

      if (!msgs.length) {
        const sep = document.createElement('div');
        sep.className = 'history-sep';
        sep.textContent = '── 这是一个空 session ──';
        $messages.appendChild(sep);
        return;
      }

      for (const m of msgs) {
        if (m.role === 'user') {
          appendUser(m.text, m.images);
        } else if (m.role === 'assistant') {
          renderHistoricalAssistant(m.text);
        } else if (m.role === 'tool_use') {
          appendToolRequest(m.toolUseId, m.name, m.input, true);
        } else if (m.role === 'tool_result') {
          onToolResult(m.toolUseId, m.content, m.isError);
        }
      }

      // Don't add the "新消息从下面开始" separator on silent re-renders —
      // it would land mid-thread on every poll.
      if (!silent) {
        const sep = document.createElement('div');
        sep.className = 'history-sep';
        const moreNote = data.total > msgs.length
          ? `（共 ${data.total} 条，已加载最近 ${msgs.length}）`
          : '';
        sep.textContent = `── 历史 ${msgs.length} 条${moreNote} · 新消息从下面开始 ──`;
        $messages.appendChild(sep);
      }
      // Scroll behaviour:
      //   First-load (silent=false): force bottom — content height just
      //     exploded, the user can't possibly want to see where they "were".
      //   Silent re-render (follow-mode polling): preserve the user's
      //     scroll. If they were near the bottom we keep them at the new
      //     bottom (so live updates stay visible); otherwise we restore
      //     their distance-from-top so reading a few screens up isn't
      //     yanked every 4s.
      requestAnimationFrame(() => {
        if (!silent || wasAtBottom) {
          $messages.scrollTop = $messages.scrollHeight;
          requestAnimationFrame(() => { $messages.scrollTop = $messages.scrollHeight; });
        } else {
          $messages.scrollTop = prevScrollTop;
        }
      });
    } catch (e) {
      if (placeholder) {
        placeholder.textContent = '── 加载历史出错: ' + (e.message || e) + ' ──';
        placeholder.classList.add('err');
      }
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
    const ok = sendWS({ type: 'select_session', sessionId: null, cwd });
    log('info', `+ 新建 → cwd=${cwd} sendWS=${ok}`);
    clearMessages();
    currentSessionId = null;
    setCwdDisplay(cwd);
    // CRITICAL UX: close the drawer so the user actually SEES the empty
    // chat area + active input. Without this, the drawer stays open over
    // the now-cleared chat, and the user thinks nothing happened ("没出现
    // 新 session 选项") because they're still looking at the session list.
    closeDrawer();
    showToast('新 session ready · 输入消息开始', 'ok', 2000);
    // Focus the composer so the user can type immediately.
    setTimeout(() => { try { $input?.focus(); } catch {} }, 100);
  }

  function clearMessages() {
    streamState.clear();
    toolCards.clear();
    $messages.innerHTML = '';
    lastTurnId = null;
    lastRenderedSeq = -1;
    lastHistoryTotal = -1;  // a new session never matches the previous total
    renderEmptyEnvCard();
  }

  // Replaces the bare "新对话" placeholder with a small env card that shows
  // cwd / account / effort and a few one-tap example prompts. Visible
  // only when the chat area is empty; first user prompt clears it.
  function renderEmptyEnvCard() {
    const wrap = document.createElement('div');
    wrap.className = 'empty env-card'; wrap.id = 'empty';

    const title = document.createElement('div');
    title.className = 'env-title';
    title.textContent = '新对话';
    wrap.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'env-grid';
    function pair(k, v) {
      const a = document.createElement('div'); a.className = 'env-k'; a.textContent = k;
      const b = document.createElement('div'); b.className = 'env-v'; b.textContent = v || '—';
      grid.appendChild(a); grid.appendChild(b);
    }
    const accountStr = (typeof $hAcct !== 'undefined' && $hAcct?.textContent) || '(default)';
    pair('cwd', currentCwd || defaultCwd || '(unset)');
    pair('account', accountStr);
    pair('effort', settings.effort || 'max');
    pair('auto-approve', settings.autoApproveTools ? '✓ yolo' : '一个个确认');
    wrap.appendChild(grid);

    const suggHead = document.createElement('div');
    suggHead.className = 'env-sugg-head';
    suggHead.textContent = '💡 一些起手 prompt';
    wrap.appendChild(suggHead);

    const sugg = document.createElement('div');
    sugg.className = 'env-sugg';
    const samples = [
      '读一下 README 和 DESIGN.md, 然后告诉我项目现状',
      '搜一下当前目录有没有 TODO/FIXME, 列出来',
      '用 markdown 表格对比 GPT-3 / GPT-4 / GPT-5 的参数量和训练成本',
      '帮我把上次的报错 trace 一下, 找到 root cause',
    ];
    for (const s of samples) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'env-sugg-btn';
      btn.textContent = s;
      btn.addEventListener('click', () => {
        $input.value = s;
        autoResize();
        setBusy(busy);  // refresh send button state
        $input.focus();
      });
      sugg.appendChild(btn);
    }
    wrap.appendChild(sugg);

    const hint = document.createElement('div');
    hint.className = 'env-hint';
    hint.textContent = '☰ session 抽屉 · 🔄 刷新 · max ⚡ 等设置在右上';
    wrap.appendChild(hint);

    $messages.appendChild(wrap);
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
    if (!$newModal) {
      log('error', '+ 新建: $newModal not found');
      return;
    }
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
      const r = await fetch(api(`/api/sessions/${encodeURIComponent(renamingSessionId)}?token=${encodeURIComponent(TOKEN)}`), {
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

    // #14: client-side image total size cap
    const totalBytes = pendingImages.reduce((s, im) => s + Math.ceil(im.data.length * 3 / 4), 0);
    if (totalBytes > 20 * 1024 * 1024) {
      showToast('图片总大小超过 20MB', 'error', 3000);
      return;
    }

    const imgs = pendingImages.slice();

    // β path: in inject mode, route to inject_to_external — server appends
    // a user-message entry to the externally-owned session's jsonl. No local
    // turn is started; the response comes back live via the jsonl-watcher
    // when cmax processes the queued message.
    if (injectMode) {
      if (!currentSessionId || !currentExternal) {
        showToast('inject 模式要求选中一个 CLI 拥有的 session', 'error', 2500);
        return;
      }
      appendUser(text, imgs);  // render locally so user sees their input
      sendWS({
        type: 'inject_to_external',
        sessionId: currentSessionId,
        text,
        images: imgs.length ? imgs : undefined,
      });
      $input.value = '';
      pendingImages = [];
      renderChips();
      autoResize();
      // Don't set busy — we didn't start a local turn. The watcher will
      // surface the queued message + any response cmax produces.
      showToast('已注入到 CLI queue · 桌面按 Enter 才会真的发', 'ok', 2500);
      return;
    }

    appendUser(text, imgs);
    sendWS({ type: 'prompt', text, images: imgs.length ? imgs : undefined });
    $input.value = '';
    pendingImages = [];
    renderChips();
    autoResize();
    setBusy(true);

    // First send is a good moment to ask for notification permission.
    requestNotifyOnFirstSend();

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
        fetch(api(`/api/sessions/${encodeURIComponent(currentSessionId)}?token=${encodeURIComponent(TOKEN)}`), {
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
    sendWS({ type: 'set_settings', autoApproveTools: next, expectedVersion: settings.version });
    // Optimistic — server will broadcast back the canonical state.
    settings.autoApproveTools = next;
    reflectSettings();
    showToast(next ? '已开启 auto 模式：工具调用自动批准' : 'auto 模式已关闭', 'ok', 2500);
  });

  async function refreshNow() {
    // Spin the icon while in-flight
    if ($refreshBtn) $refreshBtn.style.transform = 'rotate(360deg)';
    if ($refreshBtn) $refreshBtn.style.transition = 'transform 0.6s ease-out';
    try {
      // 1. reload session list (drawer)
      await loadSessions();
      await loadRecentCwds();
      // 2. if currently inside a session, pull its latest history.
      //    Clear messages and re-render — anything live since last fetch
      //    will come back via the WS subscription that's still active.
      if (currentSessionId) {
        clearMessages();
        await fetchAndRenderHistory(currentSessionId);
        showToast('已刷新 · 拉取最新历史', 'ok', 1800);
      } else {
        showToast('已刷新 session 列表', 'ok', 1500);
      }
    } catch (e) {
      log('error', 'refresh failed: ' + (e && e.message || e));
      showToast('刷新失败: ' + (e && e.message || e), 'error', 3000);
    } finally {
      if ($refreshBtn) setTimeout(() => { $refreshBtn.style.transform = ''; $refreshBtn.style.transition = ''; }, 700);
    }
  }
  if ($refreshBtn) $refreshBtn.addEventListener('click', refreshNow);

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

  // ─── v3.7 helpers (effort menu / banner / notifications) ──────
  let notifyOnDone = false;
  function openEffortMenu() { if ($effortMenu) { $effortMenu.classList.add('open'); $effortBd && $effortBd.classList.add('open'); } }
  function closeEffortMenu() { if ($effortMenu) { $effortMenu.classList.remove('open'); $effortBd && $effortBd.classList.remove('open'); } }
  function addBanner(kind, html) {
    if (!$bannerRow) return;
    const b = document.createElement('div');
    b.className = 'banner ' + kind;
    b.innerHTML = html + ' <button class="x" type="button" aria-label="dismiss">✕</button>';
    b.querySelector('.x').addEventListener('click', () => b.remove());
    $bannerRow.appendChild(b);
  }
  function maybeShowHttpsBanner() {
    if (window.isSecureContext) return;
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
    addBanner('warn',
      '⚠ HTTP 模式 — 🎤 语音不能用。host 上跑 ' +
      '<code>tailscale serve --bg https / http://localhost:8765</code> ' +
      '获取 HTTPS URL。'
    );
  }
  function maybeAskNotifyPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      notifyOnDone = true;
      // Also (re-)subscribe to push so background turn_done fires lock-screen
      // notifications even when the PWA tab is closed.
      ensurePushSubscription().catch((e) => log('warn', 'push subscribe failed: ' + (e?.message || e)));
    }
  }
  function requestNotifyOnFirstSend() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    Notification.requestPermission().then((p) => {
      notifyOnDone = (p === 'granted');
      log('info', 'notification permission: ' + p);
      if (p === 'granted') {
        ensurePushSubscription().catch((e) => log('warn', 'push subscribe failed: ' + (e?.message || e)));
      }
    }).catch(() => {});
  }

  // ── Web Push subscription ────────────────────────────────────
  // Idempotent: if already subscribed with the same VAPID key, just upserts
  // the existing endpoint server-side. If the SW isn't registered yet, waits.
  async function ensurePushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      log('info', 'push: not supported by browser');
      return;
    }
    // Need an active registration. The boot path registers SW so this should
    // always exist when we get here.
    const reg = await navigator.serviceWorker.ready;
    if (!reg) { log('warn', 'push: no SW registration'); return; }

    // Fetch VAPID public key once per session.
    const r = await fetch(api(`/api/push/vapid?token=${encodeURIComponent(TOKEN)}`));
    if (!r.ok) {
      log('warn', `push: VAPID fetch failed HTTP ${r.status}`);
      return;
    }
    const { publicKey } = await r.json();
    if (!publicKey) { log('warn', 'push: VAPID public key empty'); return; }

    // Check existing subscription. Browsers re-use if the applicationServerKey
    // matches; if it doesn't (e.g. we rotated VAPID), unsubscribe + redo.
    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // The key isn't directly exposed; we compare via toJSON's keys field
      // implicitly by trying to re-subscribe with the same key — Push API
      // dedupes if it matches.
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    const subJson = sub.toJSON();
    const deviceLabel = navigator.userAgent.slice(0, 80);
    const postRes = await fetch(api(`/api/push/subscribe?token=${encodeURIComponent(TOKEN)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subJson, deviceLabel }),
    });
    if (!postRes.ok) {
      log('warn', `push subscribe POST failed HTTP ${postRes.status}`);
      return;
    }
    const j = await postRes.json();
    log('ok', `push subscribed (total devices: ${j.total})`);
  }

  // VAPID server keys are URL-base64; the PushManager wants Uint8Array.
  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function fireDoneNotification(payload) {
    if (!notifyOnDone || !document.hidden) return;
    try {
      const dur = (payload.durationMs / 1000).toFixed(1);
      const ok = payload.success && !payload.isError;
      new Notification(ok ? 'agentphone · 完成' : 'agentphone · 出错', {
        body: dur + 's · ' + (payload.turns || 0) + ' turns · $' + ((payload.costUsd || 0).toFixed(3)),
        tag: 'agentphone-turn',
      });
    } catch (e) {
      log('warn', 'notify failed: ' + (e && e.message || e));
    }
  }

  if ($effortChip) {
    $effortChip.addEventListener('click', () => {
      ($effortMenu && $effortMenu.classList.contains('open')) ? closeEffortMenu() : openEffortMenu();
    });
  }
  if ($effortMenu) {
    $effortMenu.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const lvl = t.getAttribute('data-effort');
      if (!lvl) return;
      sendWS({ type: 'set_settings', effort: lvl, expectedVersion: settings.version });
      settings.effort = lvl;
      reflectSettings();
      closeEffortMenu();
      showToast('effort → ' + lvl, 'ok', 1800);
    });
  }
  if ($effortBd) $effortBd.addEventListener('click', closeEffortMenu);
  if ($searchBox) $searchBox.addEventListener('input', applySessionFilter);
  if (navigator.connection && typeof navigator.connection.addEventListener === 'function') {
    navigator.connection.addEventListener('change', () => {
      log('info', 'connection change → ' + (navigator.connection.effectiveType || '?'));
      if (!ws || ws.readyState !== 1) {
        log('warn', 'network changed and ws is dead — force reconnect');
        try { ws && ws.close(); } catch (e) {}
        ws = null;
        reconnectAttempts = 0;
        connect();
      }
    });
  }


  // On Android Chrome backgrounded PWAs the JS context is frequently frozen
  // and the WebSocket dies. Two failure modes to defend against:
  //   1. onclose fires while hidden but its setTimeout doesn't run until
  //      visible again — handled by reconnectTimer being cancelled on
  //      explicit connect() below.
  //   2. The WS LOOKS alive (readyState===1) but the underlying TCP was
  //      killed by mobile NAT/CGNAT silently. So after ≥10s away we don't
  //      trust readyState and force a reconnect regardless. The watchdog
  //      timestamp is also nuked so the server-silence check has a fresh
  //      baseline.
  let lastHiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      lastHiddenAt = Date.now();
      stopSpeak();
      log('info', 'page hidden');
    } else {
      const awaySec = Math.round((Date.now() - lastHiddenAt) / 1000);
      const rs = ws ? ws.readyState : 'null';
      log('info', `page visible (away ${awaySec}s, ws.readyState=${rs})`);
      // Reset watchdog baseline — a stale lastServerActivityAt from before
      // background would otherwise trigger an immediate force-reconnect.
      lastServerActivityAt = Date.now();
      const looksDead = !ws || ws.readyState !== 1;
      const possiblyZombie = awaySec >= 10;  // mobile NAT eats idle TCP fast
      if (looksDead || possiblyZombie) {
        log('warn', `ws ${looksDead ? 'not open' : 'possibly zombie'} on resume — force reconnect`);
        try { ws && ws.close(); } catch {}
        ws = null;
        reconnectAttempts = 0;
        connect(possiblyZombie ? 'visibility-zombie' : 'visibility-dead');
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
      connect('pageshow');
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

  // SW posts {kind:'push-click', sessionId} when user taps a turn-done
  // notification. We pop into that session immediately.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      const m = ev.data || {};
      if (m.kind === 'push-click' && m.sessionId && m.sessionId !== currentSessionId) {
        log('info', 'push-click: switching to session ' + m.sessionId.slice(0, 8));
        sendWS({ type: 'select_session', sessionId: m.sessionId });
      }
    });
  }

  // ─── boot ─────────────────────────────────────────────────────
  function boot() {
    TOKEN = getToken();
    if (!TOKEN) {
      if (inCapacitor()) {
        // The Capacitor bootstrap form is responsible for surfacing this;
        // index.html shows #bootstrap until both URL + token are stored.
        setStatus('error', '等设置 server URL...');
      } else {
        setStatus('error', '缺 token');
        appendError('URL 缺少 ?token=… 参数。请使用 server 启动时打印的完整地址。');
      }
      return;
    }
    maybeShowHttpsBanner();
    maybeAskNotifyPermission();
    initSTT();
    connect();
  }
  // Capacitor: bootstrap script fires this once URL + token are stored.
  window.addEventListener('agentphone-config-ready', () => {
    log('info', 'config ready — booting');
    boot();
  });
  // Browser PWA: TOKEN should already be in the URL.
  boot();
})();
