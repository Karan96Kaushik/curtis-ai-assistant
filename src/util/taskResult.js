/**
 * Standard task result envelope for evidence / confidence gating.
 * Tasks may return plain data; wrap with `withEnvelope` before leaving the task.
 */

/**
 * @param {{
 *   ok?: boolean,
 *   source?: string,
 *   confidence?: 'high'|'medium'|'low'|'none',
 *   data?: unknown,
 *   warning?: string,
 *   error?: string,
 * }} fields
 */
function withEnvelope(fields = {}) {
  const confidence = fields.confidence || 'medium';
  const ok = fields.ok !== undefined ? Boolean(fields.ok) : !fields.error;
  return {
    ok,
    source: fields.source || 'unknown',
    confidence,
    data: fields.data !== undefined ? fields.data : null,
    warning: fields.warning || undefined,
    error: fields.error || undefined,
  };
}

/**
 * Map known web/search sources to confidence.
 * @param {string} source
 * @returns {'high'|'medium'|'low'|'none'}
 */
function confidenceFromSource(source) {
  const s = String(source || '').toLowerCase();
  if (!s || s === 'unknown') return 'none';
  if (s === 'mock') return 'low';
  if (s === 'duckduckgo-html' || s === 'scrape' || s === 'booking.com') return 'medium';
  if (s === 'serper' || s === 'serpapi' || s === 'jira' || s === 'github' || s === 'org-memory') return 'high';
  return 'medium';
}

/**
 * Extract envelope from a task raw result if present, else synthesize a basic one.
 * @param {string} taskName
 * @param {object} raw
 */
function envelopeFromRaw(taskName, raw) {
  if (!raw || typeof raw !== 'object') {
    return withEnvelope({ ok: true, source: taskName, confidence: 'medium', data: raw });
  }

  if (raw.ok !== undefined && raw.confidence && raw.source) {
    return withEnvelope({
      ok: raw.ok,
      source: raw.source,
      confidence: raw.confidence,
      data: raw.data !== undefined ? raw.data : raw,
      warning: raw.warning,
      error: raw.error,
    });
  }

  // monthly activity reports — matched before the generic jira/github shapes
  // because they also carry issues[] / repos[] arrays.
  if (raw.reportType === 'jira-monthly-activity') {
    return withEnvelope({
      ok: true,
      source: 'jira',
      confidence: 'high',
      data: {
        month: raw.month,
        range: raw.range,
        issueCount: raw.issueCount,
        eventCount: raw.eventCount,
        stats: raw.stats,
        jql: raw.jql,
        issues: raw.issues,
      },
      warning: raw.detailTruncated
        ? `Timeline detail limited to the ${raw.detailIssueCount} most recently updated issues.`
        : undefined,
    });
  }

  if (raw.reportType === 'github-monthly-activity') {
    return withEnvelope({
      ok: true,
      source: 'github',
      confidence: 'high',
      data: {
        month: raw.month,
        range: raw.range,
        login: raw.user?.login,
        eventCount: raw.eventCount,
        repoCount: raw.repoCount,
        stats: raw.stats,
        repos: raw.repos,
      },
      warning: raw.truncated
        ? 'At least one GitHub search hit the result cap; counts may be partial.'
        : undefined,
    });
  }

  // web-fetch-page
  if (raw.data?.url && (raw.data.text != null || raw.source === 'axios' || raw.source === 'playwright')) {
    return withEnvelope({
      ok: raw.ok !== false && !raw.error,
      source: raw.source || 'web-fetch',
      confidence: confidenceFromSource(raw.source),
      data: raw.data,
      warning: raw.warning,
      error: raw.error,
    });
  }

  // web-search shape
  if (Array.isArray(raw.results) && raw.query != null) {
    const confidence = confidenceFromSource(raw.source);
    return withEnvelope({
      ok: raw.source !== 'mock' || Boolean(raw.warning),
      source: raw.source || 'web-search',
      confidence,
      data: { query: raw.query, results: raw.results, count: raw.count },
      warning: raw.warning || (raw.source === 'mock' ? 'Results are mock/fallback, not live search.' : undefined),
      error: raw.error,
    });
  }

  // web-check-prices shape
  if (Array.isArray(raw.listings) && raw.destination != null) {
    const hasListings = raw.listings.length > 0;
    return withEnvelope({
      ok: hasListings && !raw.error,
      source: 'booking.com',
      confidence: hasListings ? 'medium' : 'none',
      data: {
        destination: raw.destination,
        checkInDate: raw.checkInDate,
        checkOutDate: raw.checkOutDate,
        listings: raw.listings,
        searchUrl: raw.searchUrl,
      },
      warning: raw.warning,
      error: raw.error,
    });
  }

  // jira-get-issue
  if (raw.issueKey && (raw.found === true || raw.found === false || raw.description != null)) {
    return withEnvelope({
      ok: raw.found !== false && !raw.error,
      source: 'jira',
      confidence: 'high',
      data: raw,
      error: raw.error,
    });
  }

  // jira-my-issues
  if (Array.isArray(raw.issues)) {
    return withEnvelope({
      ok: true,
      source: 'jira',
      confidence: 'high',
      data: { count: raw.count, issues: raw.issues, jql: raw.jql, resolution: raw.resolution },
      warning: raw.broadenNotes?.length ? raw.broadenNotes.join(' ') : undefined,
    });
  }

  // jira create/update-ish
  if (raw.issueKey || raw.browseUrl) {
    return withEnvelope({
      ok: true,
      source: 'jira',
      confidence: 'high',
      data: raw,
    });
  }

  // github repos list/search
  if (Array.isArray(raw.repos)) {
    return withEnvelope({
      ok: true,
      source: 'github',
      confidence: 'high',
      data: raw,
      warning: raw.incomplete_results ? 'Search results may be incomplete' : undefined,
    });
  }

  // github tags
  if (Array.isArray(raw.tags) && raw.full_name) {
    return withEnvelope({
      ok: true,
      source: 'github',
      confidence: 'high',
      data: raw,
    });
  }

  // github create tag
  if (raw.tag && raw.full_name && (raw.sha || raw.ref)) {
    return withEnvelope({
      ok: raw.ok !== false,
      source: 'github',
      confidence: 'high',
      data: raw,
    });
  }

  // github PRs search/list
  if (Array.isArray(raw.pulls)) {
    return withEnvelope({
      ok: true,
      source: 'github',
      confidence: 'high',
      data: raw,
      warning: raw.incomplete_results ? 'Search results may be incomplete' : undefined,
    });
  }

  // github get PR
  if (raw.number != null && raw.full_name && (raw.found === true || raw.found === false || raw.title != null)) {
    return withEnvelope({
      ok: raw.found !== false && !raw.error,
      source: 'github',
      confidence: 'high',
      data: raw,
      error: raw.error,
    });
  }

  return withEnvelope({
    ok: !raw.error,
    source: taskName,
    confidence: 'medium',
    data: raw,
    warning: raw.warning,
    error: raw.error,
  });
}

module.exports = {
  withEnvelope,
  confidenceFromSource,
  envelopeFromRaw,
};
