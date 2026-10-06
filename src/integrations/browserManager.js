const axios = require('axios');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Fast HTTP fetches with a browser-like User-Agent.
 * Isolates axios so tasks stay thin.
 */
class BrowserManager {
  /**
   * Stateless HTTP fetch with a realistic User-Agent.
   * @param {string} url
   * @param {Record<string, string>} [headers]
   * @param {{ method?: string, data?: unknown, timeoutMs?: number, params?: Record<string, string> }} [opts]
   * @returns {Promise<{ status: number, data: any, headers: object }>}
   */
  async fastFetch(url, headers = {}, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const timeout = opts.timeoutMs ?? 15000;

    const response = await axios({
      url,
      method,
      data: opts.data,
      params: opts.params,
      timeout,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/json,*/*',
        ...headers,
      },
      // Callers inspect status; network failures still throw.
      validateStatus: () => true,
    });

    return {
      status: response.status,
      data: response.data,
      headers: response.headers || {},
    };
  }
}

const browserManager = new BrowserManager();

module.exports = browserManager;
module.exports.BrowserManager = BrowserManager;
module.exports.DEFAULT_USER_AGENT = DEFAULT_USER_AGENT;
