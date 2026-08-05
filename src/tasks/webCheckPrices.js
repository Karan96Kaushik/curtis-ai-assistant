const browserManager = require('../integrations/browserManager');

function log(...args) {
  console.error('[web-check-prices]', ...args);
}

function attachEnvelope(payload) {
  const hasListings = Array.isArray(payload.listings) && payload.listings.length > 0;
  return {
    ...payload,
    ok: hasListings && !payload.error,
    source: 'booking.com',
    confidence: hasListings ? 'medium' : 'none',
    data: {
      destination: payload.destination,
      checkInDate: payload.checkInDate,
      checkOutDate: payload.checkOutDate,
      listings: payload.listings,
      searchUrl: payload.searchUrl,
    },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build a Booking.com search-results URL from destination + stay dates.
 * @param {string} destination
 * @param {string} checkInDate
 * @param {string} checkOutDate
 */
function buildBookingSearchUrl(destination, checkInDate, checkOutDate) {
  const params = new URLSearchParams({
    ss: destination,
    checkin: checkInDate,
    checkout: checkOutDate,
    group_adults: '2',
    no_rooms: '1',
    group_children: '0',
  });
  return `https://www.booking.com/searchresults.html?${params.toString()}`;
}

/**
 * Scrape property cards from a Booking search page.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ name: string, price: string }[]>}
 */
async function scrapeListings(page) {
  // Wait for cards; Booking may show a consent banner first — dismiss if present.
  try {
    const consent = page.locator('#onetrust-accept-btn-handler, button:has-text("Accept")').first();
    if (await consent.isVisible({ timeout: 2500 }).catch(() => false)) {
      await consent.click({ timeout: 2000 }).catch(() => {});
    }
  } catch {
    // ignore consent failures
  }

  await page
    .waitForSelector('[data-testid="property-card"]', { timeout: 20000 })
    .catch(() => null);

  const listings = await page.$$eval('[data-testid="property-card"]', (cards) => {
    return cards.slice(0, 5).map((card) => {
      const titleEl = card.querySelector('[data-testid="title"]');
      const priceEl = card.querySelector('[data-testid="price-and-discounted-price"]');
      const name = (titleEl?.textContent || '').trim();
      const price = (priceEl?.textContent || '').trim().replace(/\s+/g, ' ');
      return { name, price: price || 'Price unavailable' };
    });
  });

  return listings.filter((l) => l.name);
}

/**
 * Check hotel/listing prices for a destination and date range.
 * @param {{
 *   destination?: string,
 *   checkInDate?: string,
 *   checkOutDate?: string,
 *   checkin?: string,
 *   checkout?: string,
 * }} payload
 */
async function webCheckPricesTask(payload = {}) {
  const destination = String(payload.destination || '').trim();
  const checkInDate = String(payload.checkInDate || payload.checkin || '').trim();
  const checkOutDate = String(payload.checkOutDate || payload.checkout || '').trim();

  if (!destination) throw new Error('Missing required field: destination');
  if (!checkInDate) throw new Error('Missing required field: checkInDate');
  if (!checkOutDate) throw new Error('Missing required field: checkOutDate');
  if (!DATE_RE.test(checkInDate)) {
    throw new Error('checkInDate must be YYYY-MM-DD');
  }
  if (!DATE_RE.test(checkOutDate)) {
    throw new Error('checkOutDate must be YYYY-MM-DD');
  }

  const searchUrl = buildBookingSearchUrl(destination, checkInDate, checkOutDate);
  log(`destination="${destination}" checkIn=${checkInDate} checkOut=${checkOutDate}`);
  log(`url=${searchUrl}`);

  try {
    const listings = await browserManager.runInBrowser(async (page) => {
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      // Give dynamic cards a moment to hydrate.
      await new Promise((r) => setTimeout(r, 2000));
      return scrapeListings(page);
    });

    return attachEnvelope({
      destination,
      checkInDate,
      checkOutDate,
      searchUrl,
      count: listings.length,
      listings,
      warning:
        listings.length === 0
          ? 'No property cards found — Booking.com layout/selectors may have changed, or the page blocked automation.'
          : undefined,
    });
  } catch (err) {
    log(`scrape failed: ${err.message || err}`);
    // Soft-fail so Discord/CLI loops keep running.
    return attachEnvelope({
      destination,
      checkInDate,
      checkOutDate,
      searchUrl,
      count: 0,
      listings: [],
      error: err.message || String(err),
      warning: `Price check failed: ${err.message || err}`,
    });
  }
}

function formatResult(result) {
  const lines = [
    `Prices near ${result.destination} (confidence: ${result.confidence || 'medium'})`,
    `Stay: ${result.checkInDate} → ${result.checkOutDate}`,
    `URL: ${result.searchUrl}`,
  ];
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  if (result.error && !result.warning) {
    lines.push(`Error: ${result.error}`);
  }
  if (!result.listings?.length) {
    lines.push('No listings scraped.');
    return lines.join('\n');
  }
  lines.push(`Top ${result.listings.length} listing(s):`);
  result.listings.forEach((l, i) => {
    lines.push(`${i + 1}. ${l.name} — ${l.price}`);
  });
  return lines.join('\n');
}

module.exports = webCheckPricesTask;
module.exports.formatResult = formatResult;
module.exports.buildBookingSearchUrl = buildBookingSearchUrl;
