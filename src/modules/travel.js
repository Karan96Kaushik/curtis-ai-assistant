const registry = require('../core/moduleRegistry');
const webCheckPricesTask = require('../tasks/webCheckPrices');

function executeTaskDetailed(name, payload) {
  return require('../discord/taskRunner').executeTaskDetailed(name, payload);
}

registry.register({
  id: 'travel',
  
  intent: (text) => {
    const t = String(text || '').trim();
    const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
    const PLACE_HINT_RE = /\b(paris|london|rome|berlin|amsterdam|madrid|lisbon|tokyo|nyc|new\s*york|dublin|heathrow|gatwick|stansted|luton|manchester|edinburgh|birmingham|airport)\b/i;

    function looksLikeStayDates(str) {
      if (/\b\d{4}-\d{2}-\d{2}\b/.test(str)) return true;
      if (/\b(check[- ]?in|check[- ]?out)\b/i.test(str)) return true;
      if (/\b\d{1,2}\s+[a-z]{3,9}\b/i.test(str) && MONTH_RE.test(str) && /\b(to|[-–—]|until|through)\b/i.test(str)) return true;
      if (MONTH_RE.test(str) && /\b\d{1,2}\b/.test(str) && /\b(to|[-–—]|until|through)\b/i.test(str)) return true;
      return false;
    }

    const lodging = /\b(hotel|hotels|booking\.com|airbnb|accommodation|stay|stays|room rates?|nightly|lodging)\b/i.test(t);
    const priceAsk = /\b(price|prices|pricing|cost|costs|how much|rates?)\b/i.test(t);
    const place = PLACE_HINT_RE.test(t) || /\b(in|to|for|near|around|at|by)\s+[A-Za-z][A-Za-z\s-]{1,40}\b/i.test(t);
    const dates = looksLikeStayDates(t);

    if (lodging || (priceAsk && place) || (priceAsk && dates) || (place && dates && /\b(check|look|find|get|give|hotel|stay|prices?)\b/i.test(t))) {
      return {
        domain: 'travel',
        mode: 'compare',
        budget: 'heavy',
        confidence: 'high',
        reason: 'travel'
      };
    }
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'web_check_prices',
        description: 'HEAVY browser scrape: hotel/listing prices via Booking.com (top 5 names + prices). Dates must be YYYY-MM-DD. Only for travel/price asks.',
        parameters: {
          type: 'object',
          properties: {
            destination: { type: 'string', description: 'City or place, e.g. "Paris"' },
            checkInDate: { type: 'string', description: 'Check-in YYYY-MM-DD' },
            checkOutDate: { type: 'string', description: 'Check-out YYYY-MM-DD' },
          },
          required: ['destination', 'checkInDate', 'checkOutDate'],
        },
      },
    }
  ],

  tasks: {
    'web-check-prices': {
      execute: webCheckPricesTask,
      format: webCheckPricesTask.formatResult
    }
  },

  toolHandlers: {
    web_check_prices: async (args) => {
      return executeTaskDetailed('web-check-prices', {
        destination: args.destination,
        checkInDate: args.checkInDate || args.check_in_date,
        checkOutDate: args.checkOutDate || args.check_out_date,
      });
    }
  },

  promptPack: () => {
    return [
      'Travel / price-compare mode:',
      '- Use web_check_prices with destination + checkInDate + checkOutDate (YYYY-MM-DD).',
      '- If dates are missing, ask once for them — do not invent dates.',
      '- Report only listings present in tool evidence. If scrape fails or returns 0, say so.',
      '- web_check_prices is heavy (browser); do not call it for general trivia.',
    ].join('\n');
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.domain === 'travel' || intent.mode === 'compare' || intent.budget === 'heavy') {
      if (intent.domain === 'web' || /search|look up|what is/i.test(userText)) {
        // Optional context before price scrape
        // We can just add guidance or call web_search if it's available.
        // It should be available if we merge domains, but let's assume web_search is in the allowed tools
      }
      pushTool('web_check_prices', 'Scrape listing names and prices (heavy browser)');
    }
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (tool === 'web_check_prices' && envelope.data?.listings) {
      for (const l of envelope.data.listings) {
        out.push({ type: 'listing', name: l.name, price: l.price });
      }
      if (envelope.data.destination) {
        out.push({
          type: 'stay',
          destination: envelope.data.destination,
          checkInDate: envelope.data.checkInDate,
          checkOutDate: envelope.data.checkOutDate,
        });
      }
    }
  }
});
