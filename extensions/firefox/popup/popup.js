const DEFAULT_WS_URL = 'ws://127.0.0.1:8765';

const connectionCard = document.getElementById('connectionCard');
const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');
const versionEl = document.getElementById('version');
const metaUrl = document.getElementById('metaUrl');
const metaSince = document.getElementById('metaSince');
const metaRpc = document.getElementById('metaRpc');
const metaCounts = document.getElementById('metaCounts');
const wsUrlEl = document.getElementById('wsUrl');
const tokenEl = document.getElementById('token');
const saveBtn = document.getElementById('saveBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const pauseBtn = document.getElementById('pauseBtn');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const toggleTokenBtn = document.getElementById('toggleTokenBtn');
const settingsToggle = document.getElementById('settingsToggle');
const settingsBody = document.getElementById('settingsBody');
const toastEl = document.getElementById('toast');

let toastTimer = null;
let latestStatus = null;

function normalizeWsUrl(raw) {
  let url = String(raw || '').trim() || DEFAULT_WS_URL;
  if (/^wss:\/\//i.test(url)) url = `ws://${url.slice(6)}`;
  if (!/^ws:\/\//i.test(url)) url = `ws://${url.replace(/^\/\//, '')}`;
  return url.replace(/^wss:\/\//i, 'ws://');
}

function relTime(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function showToast(text) {
  toastEl.hidden = false;
  toastEl.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function setBusy(busy) {
  saveBtn.disabled = busy;
  reconnectBtn.disabled = busy;
  pauseBtn.disabled = busy;
}

function renderStatus(s) {
  latestStatus = s;
  if (!s) {
    connectionCard.dataset.state = 'unknown';
    statusEl.textContent = 'Unknown';
    detailEl.textContent = '';
    return;
  }

  versionEl.textContent = `v${s.version || '—'}`;
  metaUrl.textContent = s.wsUrl || '—';

  if (s.paused) {
    connectionCard.dataset.state = 'paused';
    statusEl.textContent = 'Paused';
    detailEl.textContent = 'Auto-reconnect is off';
    pauseBtn.textContent = 'Resume';
  } else if (s.connected) {
    connectionCard.dataset.state = 'on';
    statusEl.textContent = 'Connected';
    detailEl.textContent = 'Curtis can drive this browser';
    pauseBtn.textContent = 'Pause';
  } else if (s.connecting) {
    connectionCard.dataset.state = 'pending';
    statusEl.textContent = 'Connecting…';
    detailEl.textContent = s.wsUrl || '';
    pauseBtn.textContent = 'Pause';
  } else {
    connectionCard.dataset.state = 'off';
    statusEl.textContent = 'Disconnected';
    const bits = [];
    if (s.lastError) bits.push(s.lastError);
    if (s.nextReconnectMs) bits.push(`retry in ~${Math.round(s.nextReconnectMs / 1000)}s`);
    else if (s.reconnectAttempt > 0) bits.push(`retry #${s.reconnectAttempt}`);
    detailEl.textContent = bits.join(' · ') || 'Start Curtis with npm start';
    pauseBtn.textContent = 'Pause';
  }

  metaSince.textContent = s.connected && s.connectedAt ? relTime(s.connectedAt) : '—';

  if (s.lastRpcMethod) {
    const mark = s.lastRpcOk === false ? '✗' : '✓';
    metaRpc.textContent = `${mark} ${s.lastRpcMethod} · ${relTime(s.lastRpcAt)}`;
  } else {
    metaRpc.textContent = 'none yet';
  }

  metaCounts.textContent = `${s.rpcOk || 0} ok · ${s.rpcFail || 0} fail`;
}

async function loadSettings() {
  const stored = await browser.storage.local.get(['wsUrl', 'token', 'settingsOpen']);
  wsUrlEl.value = normalizeWsUrl(stored.wsUrl || DEFAULT_WS_URL);
  tokenEl.value = stored.token || '';
  const open = stored.settingsOpen !== false;
  settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  settingsBody.hidden = !open;
}

async function refresh() {
  await loadSettings();
  try {
    const s = await browser.runtime.sendMessage({ type: 'getStatus' });
    renderStatus(s);
  } catch {
    connectionCard.dataset.state = 'off';
    statusEl.textContent = 'Background unavailable';
    detailEl.textContent = 'Reload the temporary add-on from about:debugging';
  }
}

async function saveAndReconnect() {
  setBusy(true);
  try {
    const wsUrl = normalizeWsUrl(wsUrlEl.value);
    wsUrlEl.value = wsUrl;
    await browser.storage.local.set({
      wsUrl,
      token: tokenEl.value.trim(),
    });
    renderStatus({ ...(latestStatus || {}), connected: false, connecting: true, paused: false, wsUrl });
    const s = await browser.runtime.sendMessage({ type: 'reconnect' });
    renderStatus(s);
    showToast('Saved and reconnecting');
  } catch (err) {
    detailEl.textContent = err.message || String(err);
  } finally {
    setBusy(false);
  }
}

reconnectBtn.addEventListener('click', async () => {
  setBusy(true);
  try {
    const s = await browser.runtime.sendMessage({ type: 'reconnect' });
    renderStatus(s);
    showToast('Reconnecting…');
  } catch (err) {
    detailEl.textContent = err.message || String(err);
  } finally {
    setBusy(false);
  }
});

pauseBtn.addEventListener('click', async () => {
  setBusy(true);
  try {
    const type = latestStatus?.paused ? 'resume' : 'pause';
    const s = await browser.runtime.sendMessage({ type });
    renderStatus(s);
    showToast(type === 'pause' ? 'Paused' : 'Resumed');
  } catch (err) {
    detailEl.textContent = err.message || String(err);
  } finally {
    setBusy(false);
  }
});

saveBtn.addEventListener('click', saveAndReconnect);

copyUrlBtn.addEventListener('click', async () => {
  const ok = await copyText(normalizeWsUrl(wsUrlEl.value));
  showToast(ok ? 'URL copied' : 'Could not copy');
});

toggleTokenBtn.addEventListener('click', () => {
  const show = tokenEl.type === 'password';
  tokenEl.type = show ? 'text' : 'password';
  toggleTokenBtn.textContent = show ? 'Hide' : 'Show';
});

settingsToggle.addEventListener('click', async () => {
  const open = settingsToggle.getAttribute('aria-expanded') !== 'true';
  settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  settingsBody.hidden = !open;
  await browser.storage.local.set({ settingsOpen: open });
});

document.querySelectorAll('.chip[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const ok = await copyText(btn.getAttribute('data-copy') || '');
    showToast(ok ? 'Copied prompt for Discord' : 'Could not copy');
  });
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status' && msg.status) renderStatus(msg.status);
});

// Keep relative times fresh while popup is open
setInterval(() => {
  if (latestStatus) renderStatus(latestStatus);
}, 5000);

refresh();
