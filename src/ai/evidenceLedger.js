/**
 * L5 — Per-turn evidence ledger for grounded synthesis & verification.
 */

const registry = require('../core/moduleRegistry');

class EvidenceLedger {
  constructor() {
    /** @type {object[]} */
    this.entries = [];
  }

  /**
   * @param {string} tool
   * @param {{ text?: string, envelope?: object, raw?: object }} payload
   */
  ingest(tool, payload = {}) {
    const text = String(payload.text || '');
    const envelope = payload.envelope || {
      ok: !/^Error:|^BLOCKED:/i.test(text),
      source: tool,
      confidence: 'medium',
      data: null,
      warning: undefined,
      error: /^Error:/i.test(text) ? text.split('\n')[0] : undefined,
    };

    const claimable = extractClaimable(tool, envelope, text);
    const entry = {
      tool,
      ok: envelope.ok !== false && !/^Error:|^BLOCKED:/i.test(text),
      source: envelope.source || tool,
      confidence: envelope.confidence || 'medium',
      warning: envelope.warning,
      error: envelope.error,
      claimable,
      textPreview: text.split('\n').slice(0, 6).join('\n').slice(0, 500),
    };
    this.entries.push(entry);
    return entry;
  }

  hasTool(name) {
    return this.entries.some((e) => e.tool === name);
  }

  successfulTools() {
    return this.entries.filter((e) => e.ok);
  }

  hasHighConfidenceWebSearch() {
    return this.entries.some(
      (e) =>
        e.tool === 'web_search' &&
        e.ok &&
        e.confidence === 'high' &&
        e.source !== 'mock'
    );
  }

  hasAnyWebSearch() {
    return this.entries.some((e) => e.tool === 'web_search');
  }

  webSearchIsMock() {
    return this.entries.some((e) => e.tool === 'web_search' && e.source === 'mock');
  }

  hasPriceListings() {
    return this.entries.some(
      (e) =>
        e.tool === 'web_check_prices' &&
        e.ok &&
        e.claimable.some((c) => c.type === 'listing')
    );
  }

  jiraIssueCount() {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.tool !== 'jira_my_issues') continue;
      const countClaim = e.claimable.find((c) => c.type === 'issue_count');
      if (countClaim) return countClaim.value;
    }
    return null;
  }

  /** Compact block for synthesizer / verifier prompts. */
  summaryForPrompt() {
    if (!this.entries.length) return 'No tool evidence this turn.';
    return this.entries
      .map((e, i) => {
        const claims = e.claimable
          .slice(0, 8)
          .map((c) => formatClaim(c))
          .join('; ');
        const warn = e.warning ? ` warning="${e.warning}"` : '';
        const err = e.error ? ` error="${e.error}"` : '';
        return [
          `${i + 1}. ${e.tool} ok=${e.ok} source=${e.source} confidence=${e.confidence}${warn}${err}`,
          claims ? `   claims: ${claims}` : '   claims: (none)',
          e.textPreview ? `   preview: ${e.textPreview.replace(/\n/g, ' | ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n');
  }

  toJSON() {
    return this.entries;
  }
}

function extractClaimable(tool, envelope, text) {
  const out = [];
  registry.extractEvidence(tool, envelope, text, out);
  return out;
}

function formatClaim(c) {
  if (c.type === 'link') return `link("${c.title}" → ${c.url})`;
  if (c.type === 'listing') return `listing("${c.name}" @ ${c.price})`;
  if (c.type === 'stay') return `stay(${c.destination} ${c.checkInDate}→${c.checkOutDate})`;
  if (c.type === 'issue_count') return `issue_count=${c.value}`;
  if (c.type === 'issue') return `issue(${c.key})`;
  if (c.type === 'side_effect') return `side_effect(${c.value})`;
  if (c.type === 'scratchpad') return `thought(${c.value})`;
  if (c.type === 'meta') return `meta(${c.value})`;
  return JSON.stringify(c);
}

module.exports = { EvidenceLedger };
