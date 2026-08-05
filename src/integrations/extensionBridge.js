/**
 * Localhost WebSocket bridge between Curtis and the Firefox extension.
 * Bind 127.0.0.1 only. Latest client wins.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const config = require('../config');

const DEFAULT_TIMEOUT_MS = 30_000;

/** @type {import('ws').WebSocket|null} */
let client = null;
/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pending = new Map();
/** @type {import('http').Server|null} */
let httpServer = null;
/** @type {WebSocketServer|null} */
let wss = null;
let started = false;

function isConnected() {
  return Boolean(client && client.readyState === 1);
}

function rejectAll(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

function attachClient(ws) {
  if (client && client !== ws) {
    try {
      // Extension treats 4000 as "replaced" and will NOT reconnect-fight
      client.close(4000, 'replaced');
    } catch (_) {
      /* ignore */
    }
  }
  client = ws;
  console.log('[extensionBridge] Firefox extension connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      const required = config.EXTENSION_WS_TOKEN;
      if (required && msg.token !== required) {
        console.warn('[extensionBridge] hello rejected: bad token');
        try {
          ws.close(4001, 'unauthorized');
        } catch (_) {
          /* ignore */
        }
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'hello_ack', version: 1, ok: true }));
      } catch (_) {
        /* ignore */
      }
      return;
    }

    if (msg.type === 'response' && msg.id) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.ok === false) {
        entry.reject(new Error(msg.error || 'extension error'));
      } else {
        entry.resolve(msg.result);
      }
    }
  });

  ws.on('close', (code) => {
    if (client === ws) {
      client = null;
      rejectAll('extension disconnected');
      if (code !== 4000) {
        console.log('[extensionBridge] Firefox extension disconnected');
      }
    }
  });

  ws.on('error', (err) => {
    console.warn('[extensionBridge] client error:', err.message || err);
  });
}

/**
 * @param {string} method
 * @param {object} [params]
 * @param {{ timeoutMs?: number }} [opts]
 */
function call(method, params = {}, opts = {}) {
  if (!isConnected()) {
    return Promise.reject(new Error('Firefox extension is not connected'));
  }

  const id = randomUUID();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`extension call timed out: ${method}`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });

    try {
      client.send(
        JSON.stringify({
          id,
          type: 'request',
          method,
          params: params || {},
        })
      );
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

/**
 * Soft-fail wrapper for tool handlers.
 * @param {string} method
 * @param {object} [params]
 * @param {{ timeoutMs?: number }} [opts]
 */
async function callSafe(method, params = {}, opts = {}) {
  try {
    const result = await call(method, params, opts);
    return { ok: true, result, error: null };
  } catch (err) {
    return { ok: false, result: null, error: err.message || String(err) };
  }
}

function start(opts = {}) {
  if (started) return;
  started = true;

  const port = Number(opts.port || config.EXTENSION_WS_PORT) || 8765;
  const host = opts.host || '127.0.0.1';

  httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Curtis extension bridge\n');
  });

  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    attachClient(ws);
  });

  httpServer.listen(port, host, () => {
    console.log(`[extensionBridge] listening on ws://${host}:${port}`);
    if (config.EXTENSION_WS_TOKEN) {
      console.log('[extensionBridge] token auth required (EXTENSION_WS_TOKEN)');
    }
  });

  httpServer.on('error', (err) => {
    console.error('[extensionBridge] server error:', err.message || err);
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[extensionBridge] port ${port} already in use — set EXTENSION_WS_PORT or free the port`
      );
    }
  });

  wss.on('error', (err) => {
    console.error('[extensionBridge] wss error:', err.message || err);
  });
}

function stop() {
  rejectAll('bridge stopped');
  if (client) {
    try {
      client.close();
    } catch (_) {
      /* ignore */
    }
    client = null;
  }
  if (wss) {
    try {
      wss.close();
    } catch (_) {
      /* ignore */
    }
    wss = null;
  }
  if (httpServer) {
    try {
      httpServer.close();
    } catch (_) {
      /* ignore */
    }
    httpServer = null;
  }
  started = false;
}

module.exports = {
  start,
  stop,
  isConnected,
  call,
  callSafe,
};
