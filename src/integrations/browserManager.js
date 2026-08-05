const axios = require('axios');
const { chromium } = require('playwright');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_VIEWPORT = { width: 1366, height: 768 };

/**
 * Centralized browser lifecycle + fast HTTP fetches.
 * Isolates Playwright/axios so tasks stay thin.
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

  /**
   * Launch headless Chromium, run `callback(page)`, then always close context/browser.
   * @template T
   * @param {(page: import('playwright').Page) => Promise<T>} callback
   * @returns {Promise<T>}
   */
  async runInBrowser(callback) {
    let browser;
    let context;
    try {
      try {
        browser = await chromium.launch({
          headless: true,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox',
          ],
        });
      } catch (err) {
        const msg = String(err?.message || err);
        if (/Executable doesn't exist|browser.*not found|Please run the following command/i.test(msg)) {
          throw new Error(
            'Playwright Chromium is not installed. From the project root run: npm run playwright:install'
          );
        }
        throw err;
      }

      context = await browser.newContext({
        userAgent: DEFAULT_USER_AGENT,
        viewport: DEFAULT_VIEWPORT,
        locale: 'en-GB',
      });

      // Light stealth: hide navigator.webdriver.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      });

      const page = await context.newPage();
      return await callback(page);
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
}

const browserManager = new BrowserManager();

module.exports = browserManager;
module.exports.BrowserManager = BrowserManager;
module.exports.DEFAULT_USER_AGENT = DEFAULT_USER_AGENT;
