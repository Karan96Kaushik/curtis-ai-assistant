function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Concurrency + spacing limiter: at most `maxConcurrent` calls in flight, and
 * each start at least `minIntervalMs` after the previous one.
 * @param {{ maxConcurrent: number, minIntervalMs: number }} opts
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
function createLimiter({ maxConcurrent, minIntervalMs }) {
  let active = 0;
  const waiting = [];
  let lastStartedAt = 0;

  function pump() {
    while (active < maxConcurrent && waiting.length) {
      active += 1;
      waiting.shift()();
    }
  }

  async function acquire() {
    if (active >= maxConcurrent) {
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    const wait = lastStartedAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastStartedAt = Date.now();
  }

  function release() {
    active -= 1;
    pump();
  }

  return async function limit(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * Parse a Retry-After header (seconds or HTTP date) into milliseconds.
 * @param {Headers} headers
 * @returns {number|null}
 */
function parseRetryAfterMs(headers) {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(seconds, 1) * 1000;
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(when - Date.now(), 1000);
  return null;
}

module.exports = { sleep, createLimiter, parseRetryAfterMs };
