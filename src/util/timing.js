/**
 * Lightweight timing helpers. Labels are unique per call to avoid collisions
 * when concurrent Discord messages are in flight.
 */

let seq = 0;

function nextId() {
  seq = (seq + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${seq}`;
}

/**
 * @param {string} label
 * @returns {{ id: string, end: (extra?: string) => number }}
 */
function startTimer(label) {
  const id = nextId();
  const full = `${label}#${id}`;
  const t0 = process.hrtime.bigint();
  console.time(`[timing] ${full}`);
  return {
    id,
    end(extra = '') {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.timeEnd(`[timing] ${full}`);
      if (extra) {
        console.log(`[timing] ${label} detail: ${extra} (${ms.toFixed(1)}ms)`);
      }
      return ms;
    },
  };
}

/**
 * Time an async function and log duration.
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {string} [extra]
 * @returns {Promise<T>}
 */
async function timeAsync(label, fn, extra) {
  const timer = startTimer(label);
  try {
    return await fn();
  } finally {
    timer.end(extra);
  }
}

module.exports = { startTimer, timeAsync, nextId };
