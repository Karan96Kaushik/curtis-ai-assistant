/**
 * Curtis Bridge — Firefox background (MV3).
 * Cleartext ws:// to local Curtis (never wss://).
 *
 * Load: about:debugging → Load Temporary Add-on → manifest.json or dist/curtis-bridge.xpi
 *
 * Debug: open about:debugging → Inspect for Curtis Bridge → Console
 * Filter by "[CurtisBridge]"
 */

const DEFAULT_WS_URL = 'ws://127.0.0.1:8765';
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const LOG_PREFIX = '[CurtisBridge]';

/** @type {WebSocket|null} */
let socket = null;
/** Monotonic id so stale socket events are ignored. */
let socketGen = 0;
let reconnectTimer = null;
let reconnectAttempt = 0;
/** When true, close handlers must not schedule another reconnect. */
let suppressReconnect = false;
let connecting = false;
/** Sockets we closed on purpose — ignore their late close events. */
const intentionalCloseSockets = new WeakSet();
let eventSeq = 0;

let status = {
  connected: false,
  connecting: false,
  paused: false,
  lastError: null,
  wsUrl: DEFAULT_WS_URL,
  reconnectAttempt: 0,
  nextReconnectMs: null,
  connectedAt: null,
  lastRpcAt: null,
  lastRpcMethod: null,
  lastRpcOk: null,
  rpcOk: 0,
  rpcFail: 0,
  version: browser.runtime.getManifest().version,
};

function readyStateName(ws) {
  if (!ws) return 'null';
  return (
    {
      [WebSocket.CONNECTING]: 'CONNECTING',
      [WebSocket.OPEN]: 'OPEN',
      [WebSocket.CLOSING]: 'CLOSING',
      [WebSocket.CLOSED]: 'CLOSED',
    }[ws.readyState] || `unknown(${ws.readyState})`
  );
}

function snapshot() {
  return {
    seq: ++eventSeq,
    gen: socketGen,
    connecting,
    suppressReconnect,
    paused: status.paused,
    reconnectAttempt,
    hasTimer: Boolean(reconnectTimer),
    socketState: readyStateName(socket),
    connected: status.connected,
    wsUrl: status.wsUrl,
    lastError: status.lastError,
  };
}

function log(level, msg, extra) {
  const line = `${LOG_PREFIX} ${msg}`;
  const payload = { ...snapshot(), ...(extra || {}) };
  if (level === 'error') console.error(line, payload);
  else if (level === 'warn') console.warn(line, payload);
  else console.log(line, payload);
}

function logInfo(msg, extra) {
  log('info', msg, extra);
}

function logWarn(msg, extra) {
  log('warn', msg, extra);
}

function logError(msg, extra) {
  log('error', msg, extra);
}

function normalizeWsUrl(raw) {
  let url = String(raw || '').trim() || DEFAULT_WS_URL;
  if (/^wss:\/\//i.test(url)) url = `ws://${url.slice(6)}`;
  if (!/^ws:\/\//i.test(url)) url = `ws://${url.replace(/^\/\//, '')}`;
  return url.replace(/^wss:\/\//i, 'ws://');
}

async function getConfig() {
  const stored = await browser.storage.local.get(['wsUrl', 'token']);
  return {
    wsUrl: normalizeWsUrl(stored.wsUrl || DEFAULT_WS_URL),
    token: stored.token || '',
  };
}

function setStatus(patch) {
  const before = {
    connected: status.connected,
    connecting: status.connecting,
    paused: status.paused,
    lastError: status.lastError,
  };
  status = { ...status, ...patch };
  const changed = Object.keys(patch).filter((k) => before[k] !== status[k]);
  if (changed.length) {
    logInfo(`status ← ${changed.join(', ')}`, {
      patch,
      connected: status.connected,
      connecting: status.connecting,
      paused: status.paused,
      lastError: status.lastError,
    });
  }
  updateBadge();
  browser.runtime.sendMessage({ type: 'status', status }).catch(() => {});
}

function updateBadge() {
  const api = browser.browserAction || browser.action;
  if (!api) return;
  try {
    if (status.paused) {
      api.setBadgeText({ text: '‖' });
      api.setBadgeBackgroundColor({ color: '#475467' });
      api.setTitle({ title: 'Curtis Bridge — paused' });
    } else if (status.connected) {
      api.setBadgeText({ text: 'on' });
      api.setBadgeBackgroundColor({ color: '#2e7d32' });
      api.setTitle({ title: `Curtis Bridge — connected (${status.wsUrl})` });
    } else if (status.connecting) {
      api.setBadgeText({ text: '…' });
      api.setBadgeBackgroundColor({ color: '#f9a825' });
      api.setTitle({ title: 'Curtis Bridge — connecting…' });
    } else {
      api.setBadgeText({ text: 'off' });
      api.setBadgeBackgroundColor({ color: '#c62828' });
      const err = status.lastError ? ` — ${status.lastError}` : '';
      api.setTitle({ title: `Curtis Bridge — disconnected${err}` });
    }
  } catch (err) {
    logWarn('updateBadge failed', { error: String(err.message || err) });
  }
}

function clearReconnectTimer(why) {
  if (reconnectTimer) {
    logInfo(`clearReconnectTimer (${why || 'unspecified'})`);
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function backoffMs() {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(reconnectAttempt, 5));
  const jitter = Math.floor(Math.random() * 400);
  return exp + jitter;
}

function scheduleReconnect(reason, source) {
  if (suppressReconnect) {
    logWarn('scheduleReconnect SKIPPED — suppressReconnect', { reason, source });
    return;
  }
  if (status.paused) {
    logWarn('scheduleReconnect SKIPPED — paused', { reason, source });
    return;
  }
  if (reconnectTimer) {
    logWarn('scheduleReconnect SKIPPED — timer already pending', {
      reason,
      source,
      nextReconnectMs: status.nextReconnectMs,
    });
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    logWarn('scheduleReconnect SKIPPED — socket still open/connecting', {
      reason,
      source,
      socketState: readyStateName(socket),
    });
    return;
  }

  const delay = backoffMs();
  reconnectAttempt += 1;
  logWarn('scheduleReconnect ARMED', {
    reason,
    source,
    delayMs: delay,
    reconnectAttempt,
    stack: new Error('scheduleReconnect stack').stack,
  });
  setStatus({
    connected: false,
    connecting: false,
    reconnectAttempt,
    nextReconnectMs: delay,
    lastError: reason || status.lastError,
  });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    logInfo('reconnect timer FIRED — calling connect()', { reason, source });
    setStatus({ nextReconnectMs: null });
    connect('timer:' + (source || reason || 'unknown')).catch((err) => {
      logError('reconnect timer connect() rejected', { error: String(err.message || err) });
    });
  }, delay);
}

/**
 * Tear down current socket without scheduling reconnect (unless scheduleAfter).
 */
function detachSocket({ scheduleAfter = false, reason = null, source = 'detachSocket' } = {}) {
  clearReconnectTimer(`detach:${source}`);
  const prev = socket;
  socket = null;
  if (!prev) {
    logInfo('detachSocket — no socket', { scheduleAfter, reason, source });
    if (scheduleAfter) scheduleReconnect(reason, source);
    return;
  }

  logInfo('detachSocket — closing socket', {
    scheduleAfter,
    reason,
    source,
    prevState: readyStateName(prev),
  });

  intentionalCloseSockets.add(prev);
  suppressReconnect = true;
  try {
    if (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING) {
      prev.close(1000, 'client_detach');
    }
  } catch (err) {
    logWarn('detachSocket close threw', { error: String(err.message || err) });
  }
  // Keep suppress briefly; intentionalCloseSockets is the real guard for late close events
  setTimeout(() => {
    suppressReconnect = false;
  }, 0);

  if (scheduleAfter) scheduleReconnect(reason, source);
}

function safeSend(obj) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    logWarn('safeSend skipped — socket not OPEN', {
      type: obj?.type,
      method: obj?.method,
      socketState: readyStateName(socket),
    });
    return false;
  }
  try {
    socket.send(JSON.stringify(obj));
    logInfo('safeSend ok', { type: obj?.type, id: obj?.id, method: obj?.method });
    return true;
  } catch (err) {
    logError('safeSend failed', { error: String(err.message || err), type: obj?.type });
    setStatus({ lastError: err.message || String(err) });
    return false;
  }
}

async function connect(source = 'connect') {
  logInfo('connect() enter', { source, stack: new Error('connect stack').stack });

  if (connecting) {
    logWarn('connect() SKIPPED — already connecting', { source });
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    logWarn('connect() SKIPPED — socket already open/connecting', {
      source,
      socketState: readyStateName(socket),
    });
    return;
  }
  if (status.paused && source !== 'resume') {
    logWarn('connect() SKIPPED — paused', { source });
    return;
  }

  connecting = true;
  clearReconnectTimer(`connect:${source}`);

  const cfg = await getConfig();
  const wsUrl = normalizeWsUrl(cfg.wsUrl);
  logInfo('connect() config loaded', {
    source,
    wsUrl,
    hasToken: Boolean(cfg.token),
  });
  setStatus({ wsUrl, connecting: true, connected: false });

  // Drop any half-open socket before opening a new one
  detachSocket({ scheduleAfter: false, reason: 'pre-connect', source: `pre-connect:${source}` });

  const gen = ++socketGen;
  let ws;
  try {
    logInfo('connect() new WebSocket()', { source, gen, wsUrl });
    ws = new WebSocket(wsUrl);
  } catch (err) {
    connecting = false;
    const msg = String(err.message || err);
    logError('connect() WebSocket constructor threw', { source, gen, error: msg });
    setStatus({ connecting: false, connected: false, lastError: msg });
    scheduleReconnect(msg, `ctor-fail:${source}`);
    return;
  }

  socket = ws;
  logInfo('connect() socket assigned', { source, gen, socketState: readyStateName(ws) });

  ws.addEventListener('open', () => {
    logInfo('WS open', { source, gen, listenerGen: gen, currentGen: socketGen });
    if (gen !== socketGen || socket !== ws) {
      logWarn('WS open IGNORED — stale generation', {
        gen,
        socketGen,
        sameSocket: socket === ws,
      });
      return;
    }
    connecting = false;
    reconnectAttempt = 0;
    setStatus({
      connected: true,
      connecting: false,
      paused: false,
      lastError: null,
      reconnectAttempt: 0,
      nextReconnectMs: null,
      connectedAt: Date.now(),
    });
    const hello = { type: 'hello', version: 1, token: cfg.token || undefined };
    logInfo('sending hello', { hasToken: Boolean(cfg.token) });
    safeSend(hello);
  });

  ws.addEventListener('message', async (event) => {
    if (gen !== socketGen || socket !== ws) {
      logWarn('WS message IGNORED — stale generation', { gen, socketGen });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      logWarn('WS message JSON parse failed', {
        error: String(err.message || err),
        preview: String(event.data).slice(0, 200),
      });
      return;
    }

    logInfo('WS message', {
      type: msg.type,
      id: msg.id,
      method: msg.method,
      ok: msg.ok,
    });

    if (msg.type === 'hello_ack') {
      logInfo('hello_ack received — session ready', { ok: msg.ok, version: msg.version });
      return;
    }
    if (msg.type !== 'request' || !msg.id) {
      logWarn('WS message ignored — not a request', { type: msg.type });
      return;
    }

    const method = msg.method || 'unknown';
    const t0 = Date.now();
    try {
      logInfo('RPC start', { method, params: msg.params || {} });
      const result = await handleRequest(method, msg.params || {});
      const ok = result?.ok !== false;
      setStatus({
        lastRpcAt: Date.now(),
        lastRpcMethod: method,
        lastRpcOk: ok,
        rpcOk: status.rpcOk + (ok ? 1 : 0),
        rpcFail: status.rpcFail + (ok ? 0 : 1),
      });
      logInfo('RPC done', { method, ok, ms: Date.now() - t0, error: result?.error });
      safeSend({ id: msg.id, type: 'response', ok: true, result });
    } catch (err) {
      // Log loudly — Firefox console truncates nested objects
      console.error(`${LOG_PREFIX} RPC THREW method=${method}`, err);
      console.error(`${LOG_PREFIX} RPC THREW stack:`, err && err.stack);
      logError('RPC threw', {
        method,
        error: String(err && (err.message || err)),
        name: err && err.name,
        stack: err && err.stack,
        ms: Date.now() - t0,
        params: msg.params || {},
      });
      setStatus({
        lastRpcAt: Date.now(),
        lastRpcMethod: method,
        lastRpcOk: false,
        rpcFail: status.rpcFail + 1,
      });
      safeSend({
        id: msg.id,
        type: 'response',
        ok: false,
        error: err.message || String(err),
      });
    }
  });

  ws.addEventListener('error', (ev) => {
    logError('WS error event', {
      source,
      gen,
      currentGen: socketGen,
      sameSocket: socket === ws,
      // Firefox often gives little detail on the error event itself
      eventType: ev?.type,
    });
    if (gen !== socketGen || socket !== ws) {
      logWarn('WS error IGNORED — stale generation');
      return;
    }
    setStatus({ lastError: 'WebSocket error (is Curtis running on this port?)' });
  });

  ws.addEventListener('close', (ev) => {
    const intentional = intentionalCloseSockets.has(ws);
    logWarn('WS close', {
      source,
      gen,
      currentGen: socketGen,
      sameSocket: socket === ws,
      code: ev.code,
      reason: ev.reason || '(none)',
      wasClean: ev.wasClean,
      intentional,
      suppressReconnect,
      paused: status.paused,
    });

    if (gen !== socketGen) {
      logWarn('WS close IGNORED — stale generation (likely replaced by newer connect)');
      return;
    }
    if (socket === ws) socket = null;
    connecting = false;

    if (intentional || suppressReconnect) {
      logInfo('WS close — no reconnect (intentional detach / suppress)', {
        intentional,
        suppressReconnect,
      });
      setStatus({ connected: false, connecting: false });
      return;
    }

    // Server closed us because a newer extension socket replaced this one — do not fight it
    if (ev.code === 4000) {
      logWarn('WS close — replaced by newer connection (4000); not reconnecting');
      setStatus({ connected: false, connecting: false, lastError: 'replaced by newer connection' });
      return;
    }

    const reason =
      ev.code === 4001
        ? 'unauthorized (check EXTENSION_WS_TOKEN)'
        : status.lastError || `disconnected (code=${ev.code} clean=${ev.wasClean} reason=${ev.reason || 'none'})`;
    setStatus({ connected: false, connecting: false, lastError: reason });
    scheduleReconnect(reason, `ws-close:${ev.code}`);
  });
}

async function reconnectNow() {
  logInfo('reconnectNow()');
  reconnectAttempt = 0;
  clearReconnectTimer('reconnectNow');
  setStatus({ paused: false, nextReconnectMs: null, reconnectAttempt: 0 });
  detachSocket({ scheduleAfter: false, reason: 'reconnectNow', source: 'reconnectNow' });
  setStatus({ connected: false, connecting: true, lastError: null });
  await connect('reconnectNow');
  return status;
}

async function pauseConnection() {
  logInfo('pauseConnection()');
  clearReconnectTimer('pause');
  detachSocket({ scheduleAfter: false, reason: 'pause', source: 'pause' });
  setStatus({
    connected: false,
    connecting: false,
    paused: true,
    nextReconnectMs: null,
    lastError: 'Paused — auto-reconnect off',
  });
  return status;
}

async function resumeConnection() {
  logInfo('resumeConnection()');
  setStatus({ paused: false, lastError: null });
  await connect('resume');
  return status;
}

async function handleRequest(method, params) {
  const p = params && typeof params === 'object' ? params : {};
  try {
    switch (method) {
      case 'browser.status':
        return browserStatus();
      case 'browser.listTabs':
        return listTabs();
      case 'browser.openTab':
        return openTab(p);
      case 'browser.navigate':
        return navigate(p);
      case 'browser.readPage':
        return readPage(p);
      case 'browser.click':
        return clickEl(p);
      case 'browser.type':
        return typeEl(p);
      default:
        return {
          ok: false,
          confidence: 'none',
          text: `Unknown method: ${method}`,
          data: null,
          error: `unknown_method:${method}`,
        };
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} handleRequest failed method=${method}`, err);
    return {
      ok: false,
      confidence: 'none',
      text: `Extension error in ${method}: ${err.message || err}`,
      data: null,
      error: String(err.message || err),
    };
  }
}

function browserStatus() {
  return {
    ok: true,
    confidence: 'high',
    text: status.connected
      ? `Firefox extension connected to ${status.wsUrl}`
      : `Firefox extension not connected (${status.lastError || 'disconnected'})`,
    data: {
      connected: status.connected,
      connecting: status.connecting,
      wsUrl: status.wsUrl,
      lastError: status.lastError,
      reconnectAttempt: status.reconnectAttempt,
    },
  };
}

async function listTabs() {
  const tabs = await browser.tabs.query({});
  const data = tabs.map((t) => ({
    id: t.id,
    title: t.title || '',
    url: t.url || '',
    active: Boolean(t.active),
    windowId: t.windowId,
  }));
  const lines = data.slice(0, 40).map((t) => `${t.active ? '* ' : '  '}[${t.id}] ${t.title} — ${t.url}`);
  return {
    ok: true,
    confidence: 'high',
    text: `Open tabs (${data.length}):\n${lines.join('\n')}`,
    data: { tabs: data, count: data.length },
  };
}

async function openTab({ url, activate = true } = {}) {
  if (!url || !String(url).trim()) {
    return {
      ok: false,
      confidence: 'none',
      text: 'url required',
      data: null,
      error: 'url_required',
    };
  }
  let normalized = String(url).trim();
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;

  logInfo('openTab', { url: normalized, activate });

  try {
    const existing = await browser.tabs.query({ url: [normalized, `${normalized}*`] });
    if (existing && existing[0]) {
      await focusTab(existing[0], activate !== false);
      return {
        ok: true,
        confidence: 'high',
        text: `Focused existing tab ${existing[0].id}: ${existing[0].url || normalized}`,
        data: {
          tabId: existing[0].id,
          url: existing[0].url || normalized,
          reused: true,
          opened: false,
        },
      };
    }
  } catch (err) {
    logWarn('openTab existing-tab query failed', { error: String(err.message || err) });
  }

  const tab = await browser.tabs.create({ url: normalized, active: activate !== false });
  if (activate !== false && tab.windowId != null) {
    try {
      await browser.windows.update(tab.windowId, { focused: true });
    } catch (err) {
      logWarn('openTab windows.update failed', { error: String(err.message || err) });
    }
  }
  return {
    ok: true,
    confidence: 'high',
    text: `Opened tab ${tab.id}: ${normalized}`,
    data: { tabId: tab.id, url: normalized, reused: false, opened: true },
  };
}

async function navigate({ url, tabId }) {
  if (!url) throw new Error('url required');
  let normalized = String(url).trim();
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;

  const tab = tabId
    ? await browser.tabs.get(tabId)
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) throw new Error('No tab found');
  const updated = await browser.tabs.update(tab.id, { url: normalized, active: true });
  return {
    ok: true,
    confidence: 'high',
    text: `Navigated tab ${updated.id} → ${normalized}`,
    data: { tabId: updated.id, url: normalized },
  };
}

async function ensureTab(tabId) {
  if (tabId != null) return browser.tabs.get(tabId);
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error('No active tab');
  return tabs[0];
}

async function executeInTab(tabId, func, args = []) {
  logInfo('executeInTab', { tabId, argCount: (args || []).length });
  let results;
  try {
    results = await browser.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });
  } catch (err) {
    const msg = String(err.message || err);
    logError('executeInTab executeScript failed', { tabId, error: msg });
    if (/non-structured-clonable/i.test(msg)) {
      throw new Error(
        'Page script returned non-clonable data (DOM nodes/functions). Return JSON-safe primitives only.'
      );
    }
    throw err;
  }
  const first = results && results[0];
  if (!first) throw new Error('scripting.executeScript returned no result');
  if (first.error) throw new Error(first.error.message || String(first.error));
  // Defensive second clone in extension context
  try {
    return first.result == null ? null : JSON.parse(JSON.stringify(first.result));
  } catch (err) {
    logError('executeInTab result re-clone failed', { error: String(err.message || err) });
    return first.result;
  }
}

async function readPage({ tabId, selector, maxChars = 8000 } = {}) {
  const tab = await ensureTab(tabId);
  const result = await executeInTab(
    tab.id,
    (sel, max) => {
      const clone = (v) => JSON.parse(JSON.stringify(v));
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return clone({ ok: false, error: `selector not found: ${sel}` });
      const text = String(root.innerText || root.textContent || '')
        .replace(/\s+\n/g, '\n')
        .trim();
      const clipped = text.slice(0, max);
      return clone({
        ok: true,
        title: String(document.title || ''),
        url: String(location.href || ''),
        text: clipped,
        truncated: text.length > max,
        length: text.length,
      });
    },
    [selector || null, maxChars]
  );

  if (!result || result.ok === false) {
    return {
      ok: false,
      confidence: 'none',
      text: result?.error || 'Failed to read page',
      data: null,
      error: result?.error || 'read_failed',
    };
  }

  return {
    ok: true,
    confidence: 'high',
    text: `Page: ${result.title}\nURL: ${result.url}\n\n${result.text}${result.truncated ? '\n…(truncated)' : ''}`,
    data: result,
  };
}

async function clickEl({ selector, tabId, text } = {}) {
  if (!selector && !text) {
    return {
      ok: false,
      confidence: 'none',
      text: 'selector or text required',
      data: null,
      error: 'selector_required',
    };
  }
  const tab = await ensureTab(tabId);
  logInfo('clickEl', { selector, text, tabId: tab.id, url: tab.url });
  const result = await executeInTab(
    tab.id,
    (sel, byText) => {
      const clone = (v) => JSON.parse(JSON.stringify(v));

      function norm(s) {
        return String(s || '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function findByVisibleText(needle, tagHint) {
        const n = norm(needle).toLowerCase();
        if (!n) return null;
        const tag = tagHint ? String(tagHint).toUpperCase() : '';

        const candidates = document.querySelectorAll(
          'a, button, [role="button"], [role="treeitem"], [role="option"], [role="menuitem"], [role="link"], [role="tab"], span, div, label'
        );
        let partialGen = null;
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i];
          if (tag && el.tagName !== tag) continue;
          const t = norm(el.innerText || el.textContent);
          if (!t || t.length > 240) continue;
          const tl = t.toLowerCase();
          if (tl === n) return el;
          if (!partialGen && tl.includes(n) && t.length < 120) partialGen = el;
        }
        return partialGen;
      }

      function resolve(selIn, textIn) {
        const needleFromText = textIn && String(textIn).trim();
        if (needleFromText) return findByVisibleText(needleFromText, null);

        const s = String(selIn || '').trim();
        if (!s) return null;

        // Explicit text selectors: text=Foo | text:"Foo" | contains:Foo
        const textSel = s.match(/^(?:text|contains)\s*[=:]\s*(?:"([^"]+)"|'([^']+)'|(.+))$/i);
        if (textSel) {
          return findByVisibleText(textSel[1] || textSel[2] || textSel[3], null);
        }

        try {
          const el = document.querySelector(s);
          if (el) return el;
        } catch (_) {
          /* invalid CSS — try text fallbacks below */
        }

        // LLM often invents span[title="Chat Name"] — titles are textContent, not attributes
        const attrSel = s.match(
          /^(?:([a-zA-Z][\w-]*))?\[(title|aria-label)=["']([^"']+)["']\]$/i
        );
        if (attrSel) {
          return findByVisibleText(attrSel[3], attrSel[1] || null);
        }

        return null;
      }

      const el = resolve(sel, byText);
      if (!el) {
        return clone({
          ok: false,
          error: `element not found: ${byText ? `text=${byText}` : sel} (matched by visible text / CSS)`,
        });
      }
      try {
        el.focus?.();
        el.click();
      } catch (err) {
        return clone({
          ok: false,
          error: `click failed: ${err && err.message ? err.message : String(err)}`,
        });
      }
      return clone({
        ok: true,
        tag: String(el.tagName || ''),
        text: norm(el.innerText || el.textContent).slice(0, 80),
        matchedBy: byText || /^(?:text|contains)\s*[=:]/i.test(String(sel || '')) || /\[(title|aria-label)=/i.test(String(sel || ''))
          ? 'text'
          : 'css',
      });
    },
    [selector ? String(selector) : null, text ? String(text) : null]
  );
  if (!result?.ok) {
    return {
      ok: false,
      confidence: 'none',
      text: result?.error || 'click failed',
      data: null,
      error: result?.error || 'click_failed',
    };
  }
  return {
    ok: true,
    confidence: 'high',
    text: `Clicked ${result.tag}${result.text ? `: ${result.text}` : ''} (${result.matchedBy === 'text' ? 'by text' : selector})`,
    data: result,
  };
}

async function typeEl({ selector, text, clear = true, tabId } = {}) {
  if (!selector) {
    return {
      ok: false,
      confidence: 'none',
      text: 'selector required',
      data: null,
      error: 'selector_required',
    };
  }
  if (text == null) {
    return {
      ok: false,
      confidence: 'none',
      text: 'text required',
      data: null,
      error: 'text_required',
    };
  }
  const tab = await ensureTab(tabId);
  const result = await executeInTab(
    tab.id,
    (sel, value, shouldClear) => {
      const clone = (v) => JSON.parse(JSON.stringify(v));
      const el = document.querySelector(sel);
      if (!el) return clone({ ok: false, error: `element not found: ${sel}` });
      try {
        el.focus();
        if (shouldClear) {
          if ('value' in el) el.value = '';
          else el.textContent = '';
        }
        if ('value' in el) {
          el.value = String(el.value || '') + String(value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = String(el.textContent || '') + String(value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (err) {
        return clone({ ok: false, error: `type failed: ${err && err.message ? err.message : String(err)}` });
      }
      return clone({ ok: true, tag: String(el.tagName || '') });
    },
    [String(selector), String(text), clear !== false]
  );
  if (!result?.ok) {
    return {
      ok: false,
      confidence: 'none',
      text: result?.error || 'type failed',
      data: null,
      error: result?.error || 'type_failed',
    };
  }
  return {
    ok: true,
    confidence: 'high',
    text: `Typed into ${result.tag} (${selector})`,
    data: { ...result, length: String(text).length },
  };
}

async function focusTab(tab, activate = true) {
  if (!tab || tab.id == null) {
    logWarn('focusTab skipped — no tab');
    return;
  }
  if (activate === false) return;
  try {
    logInfo('focusTab', { tabId: tab.id, windowId: tab.windowId, url: tab.url });
    await browser.tabs.update(tab.id, { active: true });
  } catch (err) {
    logError('focusTab tabs.update failed', { tabId: tab.id, error: String(err.message || err) });
    throw err;
  }
  if (tab.windowId != null) {
    try {
      await browser.windows.update(tab.windowId, { focused: true });
    } catch (err) {
      logWarn('focusTab windows.update failed (non-fatal)', {
        windowId: tab.windowId,
        error: String(err.message || err),
      });
    }
  }
}

browser.runtime.onMessage.addListener((msg) => {
  logInfo('runtime message', { type: msg?.type });
  if (msg?.type === 'getStatus') return Promise.resolve(status);
  if (msg?.type === 'reconnect') return reconnectNow();
  if (msg?.type === 'pause') return pauseConnection();
  if (msg?.type === 'resume') return resumeConnection();
  return undefined;
});

browser.storage.onChanged.addListener((changes, area) => {
  logInfo('storage.onChanged', {
    area,
    keys: Object.keys(changes || {}),
    wsUrl: changes.wsUrl ? { old: changes.wsUrl.oldValue, new: changes.wsUrl.newValue } : undefined,
    tokenChanged: Boolean(changes.token),
  });
});

if (browser.runtime.onInstalled) {
  browser.runtime.onInstalled.addListener((details) => {
    logInfo('runtime.onInstalled', { reason: details.reason, temporary: details.temporary });
  });
}

if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    logInfo('runtime.onStartup');
  });
}

logInfo('background script boot', {
  version: status.version,
  href: typeof location !== 'undefined' ? location.href : '(no location)',
});

// Single boot connect; backoff handles offline Curtis
connect('boot').catch((err) => {
  logError('boot connect() rejected', { error: String(err.message || err) });
});
updateBadge();
