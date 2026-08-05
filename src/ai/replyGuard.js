/**
 * L7 — Pre-send claim / grounding gate.
 * Detects replies that claim side-effects or web facts without matching evidence.
 */

const SUCCESS_CLAIM_RE =
  /\b(i('ve| have)?\s+(updated|created|deleted|saved|appended|written|cleared|remembered|stored)|successfully\s+(updated|created|deleted|saved|appended)|memory\s+has\s+been|context\s+has\s+been\s+updated|i\s+updated\s+(the\s+)?(context|memory|org\s*memory))\b/i;

const WEB_SEARCH_CLAIM_RE =
  /\b(i\s+(searched|looked up)|according to (my |the )?search|search results? (show|say)|from the web|online sources?)\b/i;

const PRICE_CLAIM_RE =
  /\b(per night|nightly|hotels? (from|start|cost)|listing[s]? (at|from)|£\d|\$\d|€\d|prices? (for|in))\b/i;

const WRITE_TOOLS = new Set([
  'jira_create',
  'jira_update',
  'jira_delete_comment',
  'confirm_pending',
  'memory_append',
  'memory_write',
  'clear_context',
  'cancel_pending',
  'wf_release_execute_pending',
]);

/**
 * @param {{ name: string, result: string }[]} toolResults
 */
function summarizeToolOutcomes(toolResults) {
  if (!toolResults.length) return 'No tools ran this turn.';
  return toolResults
    .map(({ name, result }) => {
      const text = String(result || '');
      const status = /^Error:|^BLOCKED:/i.test(text)
        ? 'failed'
        : /PENDING CONFIRMATION/i.test(text)
          ? 'staged'
          : /Appended to org memory|Wrote org memory|Created |Updated |Deleted |Cancelled /i.test(text)
            ? 'ok'
            : 'ran';
      const hint = text.split('\n')[0].slice(0, 120);
      return `${name} → ${status}${hint ? ` (${hint})` : ''}`;
    })
    .join('; ');
}

/**
 * Compact note for conversation history.
 * @param {{ name: string, result: string }[]} toolResults
 */
function compactToolNote(toolResults) {
  if (!toolResults.length) return '';
  const parts = toolResults.map(({ name, result }) => {
    const text = String(result || '');
    let status = 'ok';
    if (/^Error:|^BLOCKED:/i.test(text)) status = 'error';
    else if (/PENDING CONFIRMATION/i.test(text)) status = 'staged';
    else if (/No (unresolved |resolved )?issues|0 issue/i.test(text)) status = 'empty';
    else if (/Assigned to you.*?(\d+)\s+issue/i.test(text)) {
      const m = text.match(/Assigned to you[^:]*:\s*(\d+)/i);
      status = m ? `${m[1]} issues` : 'ok';
    } else if (/Appended to org memory|Wrote org memory/i.test(text)) status = 'memory-ok';
    else if (/source:\s*mock/i.test(text)) status = 'mock';
    else if (/No listings scraped|Price check failed/i.test(text)) status = 'empty';

    const filters = [];
    const jql = text.match(/^JQL:\s*(.+)$/m);
    if (jql) {
      if (/issuetype in/i.test(jql[1])) filters.push('typed');
      if (/summary\s*~/i.test(jql[1])) filters.push('queried');
    }
    const filterBit = filters.length ? ` [${filters.join(',')}]` : '';
    return `${name} → ${status}${filterBit}`;
  });
  return `[tools this turn: ${parts.join('; ')}]`;
}

function hasSuccessfulWrite(toolResults) {
  return toolResults.some(({ name, result }) => {
    if (!WRITE_TOOLS.has(name)) return false;
    const r = String(result || '');
    if (/^Error:|^BLOCKED:|PENDING CONFIRMATION/i.test(r)) return false;
    if (['jira_create', 'jira_update', 'jira_delete_comment'].includes(name)) {
      return /Created |Updated |Deleted /i.test(r);
    }
    if (name === 'confirm_pending') {
      return /Created |Updated |Deleted /i.test(r);
    }
    if (name === 'memory_append' || name === 'memory_write') {
      return /Appended to org memory|Wrote org memory|ok/i.test(r) && !/^Error:/i.test(r);
    }
    if (name === 'clear_context') return /cleared/i.test(r);
    if (name === 'cancel_pending') return /Cancelled/i.test(r);
    return false;
  });
}

/**
 * @param {string} reply
 * @param {{ name: string, result: string }[]} toolResults
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkReplyClaims(reply, toolResults) {
  const text = String(reply || '');
  if (!SUCCESS_CLAIM_RE.test(text)) {
    return { ok: true };
  }
  if (hasSuccessfulWrite(toolResults)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'Reply claims a side-effect success but no matching successful write tool result in this turn.',
  };
}

/**
 * Extended grounding check using evidence ledger when available.
 * @param {string} reply
 * @param {{ name: string, result: string }[]} toolResults
 * @param {import('./evidenceLedger').EvidenceLedger | null} [evidence]
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkReplyGrounding(reply, toolResults, evidence = null) {
  const claimCheck = checkReplyClaims(reply, toolResults);
  if (!claimCheck.ok) return claimCheck;

  const text = String(reply || '');

  if (WEB_SEARCH_CLAIM_RE.test(text)) {
    const searched = toolResults.some((t) => t.name === 'web_search');
    if (!searched) {
      return { ok: false, reason: 'Reply claims a web search but web_search did not run this turn.' };
    }
    if (evidence?.webSearchIsMock() && !/\b(mock|fallback|low[- ]confidence|no live|unavailable)\b/i.test(text)) {
      return {
        ok: false,
        reason: 'Reply presents web findings without disclosing mock/low-confidence search results.',
      };
    }
  }

  if (PRICE_CLAIM_RE.test(text)) {
    const priced = toolResults.some((t) => t.name === 'web_check_prices');
    if (!priced) {
      return {
        ok: false,
        reason: 'Reply claims hotel/listing prices but web_check_prices did not run this turn.',
      };
    }
    if (evidence && !evidence.hasPriceListings()) {
      if (!/\b(could not|couldn't|unable|failed|no listings|blocked|unavailable)\b/i.test(text)) {
        return {
          ok: false,
          reason: 'Reply claims prices but evidence has no listing claims (scrape empty/failed).',
        };
      }
    }
  }

  // Soft check: "no tickets" vs tool showing issues
  const myIssues = toolResults.filter((t) => t.name === 'jira_my_issues').pop();
  if (
    myIssues &&
    /Assigned to you/i.test(myIssues.result) &&
    /\bno\s+(active\s+)?tickets?\b/i.test(text) &&
    !/No (unresolved |resolved )?issues/i.test(myIssues.result)
  ) {
    return {
      ok: false,
      reason: 'Reply claims no tickets but jira_my_issues returned assigned issues.',
    };
  }

  return { ok: true };
}

/**
 * Safe fallback when repair still fails.
 * @param {{ name: string, result: string }[]} toolResults
 * @param {import('./evidenceLedger').EvidenceLedger | null} [evidence]
 */
function fallbackFromTools(toolResults, evidence = null) {
  const summary = evidence ? evidence.summaryForPrompt() : summarizeToolOutcomes(toolResults);
  return [
    'I could not produce a grounded reply that matched the tool outcomes.',
    evidence ? 'Evidence:' : `Tool outcomes: ${summary}`,
    evidence ? summary : '',
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  SUCCESS_CLAIM_RE,
  WEB_SEARCH_CLAIM_RE,
  PRICE_CLAIM_RE,
  WRITE_TOOLS,
  summarizeToolOutcomes,
  compactToolNote,
  checkReplyClaims,
  checkReplyGrounding,
  fallbackFromTools,
};
