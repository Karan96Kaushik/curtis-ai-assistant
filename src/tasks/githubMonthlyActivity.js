const { createGithubClient, GithubError } = require('../integrations/githubClient');
const { resolveMonth } = require('../util/monthRange');
const config = require('../config');

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10; // GitHub search caps at 1000 results
const SEARCH_GAP_MS = 350; // stay under 30 search req/min
const RETRY_STATUSES = new Set([403, 429]);
const MAX_SCOPES = 8; // keep alias queries short enough for the search API
const MAX_ALIASES = 5;
const MAX_BRANCH_REPOS = 75;
const MAX_BRANCHES_PER_REPO = 60;
const MAX_COMMIT_PAGES = 3;
const BRANCH_CONCURRENCY = 8;

function log(...args) {
  console.error('[github-monthly-activity]', ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtStamp(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 16).replace('T', ' ');
}

function truncate(text, max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function toList(value) {
  if (value == null || value === '') return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map((s) => String(s).trim()).filter(Boolean);
}

function uniqueByLower(values) {
  const seen = new Map();
  for (const v of values) {
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.values()];
}

function repoFromUrl(htmlUrl) {
  const m = String(htmlUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function repoOf(item) {
  return (
    item.repository?.full_name ||
    repoFromUrl(item.html_url) ||
    item.repository_url?.replace(/.*\/repos\//, '') ||
    'unknown'
  );
}

function dateInMonth(iso, start, end) {
  if (!iso) return false;
  const d = String(iso).slice(0, 10);
  return d >= start && d <= end;
}

/** Paginate a search endpoint, retrying transient secondary rate limits. */
async function searchAll(label, fetchPage, maxPages) {
  const items = [];
  let totalCount = null;
  let truncated = false;

  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    for (let attempt = 0; ; attempt += 1) {
      try {
        data = await fetchPage(page);
        break;
      } catch (err) {
        const retryable = err instanceof GithubError && RETRY_STATUSES.has(err.status);
        if (!retryable || attempt >= 3) throw err;
        const wait = 2000 * (attempt + 1);
        log(`${label}: rate-limited, retrying in ${wait}ms`);
        await sleep(wait);
      }
    }

    totalCount = data.total_count ?? totalCount;
    const batch = data.items || [];
    items.push(...batch);

    if (!batch.length || batch.length < PAGE_SIZE) break;
    if (totalCount != null && items.length >= totalCount) break;
    if (page === maxPages) truncated = true;
    else await sleep(SEARCH_GAP_MS);
  }

  if (totalCount != null && totalCount > items.length) truncated = true;
  log(`${label}: ${items.length}/${totalCount ?? items.length}${truncated ? ' (truncated)' : ''}`);

  return { items, totalCount: totalCount ?? items.length, truncated };
}

function commitEvent(c, { roles, identities, repo, branch, foundVia }) {
  const author = c.commit?.author || {};
  const committer = c.commit?.committer || {};
  const roleList = [...new Set(roles.filter(Boolean))].sort();
  return {
    at: roleList.includes('author')
      ? author.date || committer.date
      : committer.date || author.date,
    kind: 'commit',
    role: roleList.join('+'),
    repo: repo || repoOf(c),
    title: truncate(c.commit?.message?.split('\n')[0] || '(no message)'),
    url: c.html_url,
    sha: c.sha?.slice(0, 7),
    author: c.author?.login || null,
    authorName: author.name || null,
    authorEmail: author.email || null,
    committerName: committer.name || null,
    committerEmail: committer.email || null,
    identities: [...identities],
    branches: branch ? [branch] : [],
    foundVia: [foundVia],
  };
}

/**
 * Every search that can be scoped to a GitHub account login.
 * PR/issue search only supports account logins, never git name/email.
 */
async function collectForLogin(github, login, period, { maxPages, record }) {
  const { dateRange } = period;
  const events = [];
  const identity = `@${login}`;

  const commitSearch = (q, sort) => (page) =>
    github.searchCommits({ q, per_page: PAGE_SIZE, page, sort, order: 'desc' });
  const issueSearch = (q, sort) => (page) =>
    github.searchIssues({ q, per_page: PAGE_SIZE, page, sort, order: 'desc' });

  const authored = await record(
    `commitsAuthored(${identity})`,
    `author:${login} author-date:${dateRange}`,
    (q) => searchAll(`commitsAuthored(${identity})`, commitSearch(q, 'author-date'), maxPages)
  );
  for (const c of authored.items) {
    events.push(commitEvent(c, { roles: ['author'], identities: [identity], foundVia: 'search' }));
  }

  const committed = await record(
    `commitsCommitted(${identity})`,
    `committer:${login} committer-date:${dateRange}`,
    (q) => searchAll(`commitsCommitted(${identity})`, commitSearch(q, 'committer-date'), maxPages)
  );
  for (const c of committed.items) {
    events.push(
      commitEvent(c, { roles: ['committer'], identities: [identity], foundVia: 'search' })
    );
  }

  const prsCreated = await record(
    `prsCreated(${identity})`,
    `author:${login} type:pr created:${dateRange}`,
    (q) => searchAll(`prsCreated(${identity})`, issueSearch(q, 'created'), maxPages)
  );
  for (const pr of prsCreated.items) {
    events.push({
      at: pr.created_at,
      kind: 'pr_created',
      repo: repoOf(pr),
      title: truncate(`#${pr.number} ${pr.title}`),
      url: pr.html_url,
      state: pr.pull_request?.merged_at ? 'merged' : pr.state,
      number: pr.number,
      author: pr.user?.login || null,
      identities: [identity],
    });
  }

  const prsInvolved = await record(
    `prsInvolved(${identity})`,
    `involves:${login} type:pr updated:${dateRange}`,
    (q) => searchAll(`prsInvolved(${identity})`, issueSearch(q, 'updated'), maxPages)
  );
  for (const pr of prsInvolved.items) {
    const own = String(pr.user?.login || '').toLowerCase() === login.toLowerCase();
    events.push({
      at: pr.updated_at,
      kind: own ? 'pr_updated' : 'pr_involved',
      repo: repoOf(pr),
      title: truncate(`#${pr.number} ${pr.title}`),
      url: pr.html_url,
      state: pr.pull_request?.merged_at ? 'merged' : pr.state,
      number: pr.number,
      author: pr.user?.login || null,
      createdAt: pr.created_at,
      identities: [identity],
    });
  }

  const prsReviewed = await record(
    `prsReviewed(${identity})`,
    `reviewed-by:${login} type:pr updated:${dateRange}`,
    (q) => searchAll(`prsReviewed(${identity})`, issueSearch(q, 'updated'), maxPages)
  );
  for (const pr of prsReviewed.items) {
    events.push({
      at: pr.updated_at,
      kind: 'pr_reviewed',
      repo: repoOf(pr),
      title: truncate(`#${pr.number} ${pr.title}`),
      url: pr.html_url,
      state: pr.pull_request?.merged_at ? 'merged' : pr.state,
      number: pr.number,
      author: pr.user?.login || null,
      identities: [identity],
    });
  }

  const issues = await record(
    `issuesInvolved(${identity})`,
    `involves:${login} type:issue updated:${dateRange}`,
    (q) => searchAll(`issuesInvolved(${identity})`, issueSearch(q, 'updated'), maxPages)
  );
  for (const issue of issues.items) {
    const createdByMe =
      String(issue.user?.login || '').toLowerCase() === login.toLowerCase() &&
      dateInMonth(issue.created_at, period.start, period.end);
    events.push({
      at: createdByMe ? issue.created_at : issue.updated_at,
      kind: createdByMe ? 'issue_created' : 'issue_involved',
      repo: repoOf(issue),
      title: truncate(`#${issue.number} ${issue.title}`),
      url: issue.html_url,
      state: issue.state,
      number: issue.number,
      author: issue.user?.login || null,
      identities: [identity],
    });
  }

  const commented = await record(
    `commented(${identity})`,
    `commenter:${login} updated:${dateRange}`,
    (q) => searchAll(`commented(${identity})`, issueSearch(q, 'updated'), maxPages)
  );
  for (const item of commented.items) {
    events.push({
      at: item.updated_at,
      kind: item.pull_request ? 'pr_commented' : 'issue_commented',
      repo: repoOf(item),
      title: truncate(`#${item.number} ${item.title}`),
      url: item.html_url,
      state: item.state,
      number: item.number,
      author: item.user?.login || null,
      identities: [identity],
    });
  }

  return events;
}

/** Every repo the token can see, newest push first. */
async function loadAccessibleRepos(github) {
  const repos = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await github.listRepos({ per_page: PAGE_SIZE, page, sort: 'pushed' });
    if (!Array.isArray(batch) || !batch.length) break;
    repos.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return repos;
}

/**
 * Owner scopes for alias searches. Unscoped name/email search would match
 * unrelated people across all of GitHub, so aliases are only searched inside
 * repos this token can already see.
 */
function resolveSearchScopes(repos, logins, isExcludedOwner) {
  const counts = new Map();
  const owners = new Map();

  for (const login of logins) {
    if (isExcludedOwner(login)) continue;
    owners.set(login.toLowerCase(), { login, type: 'User' });
    counts.set(login.toLowerCase(), Number.MAX_SAFE_INTEGER);
  }

  for (const repo of repos) {
    const owner = repo.owner;
    if (!owner?.login || isExcludedOwner(owner.login)) continue;
    const key = owner.login.toLowerCase();
    if (!owners.has(key)) {
      owners.set(key, {
        login: owner.login,
        type: owner.type === 'Organization' ? 'Organization' : 'User',
      });
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...owners.entries()]
    .sort((a, b) => (counts.get(b[0]) || 0) - (counts.get(a[0]) || 0))
    .slice(0, MAX_SCOPES)
    .map(([, owner]) => owner);
}

/** Which of author/committer on this commit belong to the user. */
function matchCommitIdentities(c, { loginSet, aliases }) {
  const roles = [];
  const identities = [];

  const check = (role, accountLogin, name, email) => {
    const login = String(accountLogin || '').toLowerCase();
    if (login && loginSet.has(login)) {
      roles.push(role);
      identities.push(`@${accountLogin}`);
      return;
    }
    const haystack = `${name || ''} ${email || ''}`.toLowerCase();
    const alias = aliases.find((a) => haystack.includes(a));
    if (alias) {
      roles.push(role);
      identities.push(`name/email ~"${alias}"`);
    }
  };

  const author = c.commit?.author || {};
  const committer = c.commit?.committer || {};
  check('author', c.author?.login, author.name, author.email);
  check('committer', c.committer?.login, committer.name, committer.email);

  return { roles: [...new Set(roles)], identities: uniqueByLower(identities) };
}

/** Bounded-concurrency map that keeps input order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Commit search only indexes default branches. Walk every branch of repos that
 * were pushed during or after the month so feature-branch work is included.
 */
async function collectFromBranches(github, repos, period, { loginSet, aliases }) {
  const since = `${period.start}T00:00:00Z`;
  const until = `${period.endExclusive}T00:00:00Z`;

  const stats = {
    reposScanned: 0,
    branchesScanned: 0,
    reposCapped: false,
    branchesCapped: false,
  };

  const candidates = repos.slice(0, MAX_BRANCH_REPOS);
  stats.reposCapped = repos.length > candidates.length;

  const perRepo = await mapWithConcurrency(candidates, BRANCH_CONCURRENCY, async (repo) => {
    const [owner, name] = String(repo.full_name || '').split('/');
    if (!owner || !name) return [];

    let branches;
    try {
      branches = await github.listBranches({ owner, repo: name, per_page: PAGE_SIZE });
    } catch (err) {
      log(`branches ${repo.full_name}: skipped (${err.status || ''} ${err.message || err})`);
      return [];
    }
    if (!Array.isArray(branches) || !branches.length) return [];

    const refs = branches.slice(0, MAX_BRANCHES_PER_REPO).map((b) => b.name);
    if (branches.length > refs.length) stats.branchesCapped = true;
    stats.reposScanned += 1;

    const events = [];
    const seenSha = new Set();

    for (const ref of refs) {
      stats.branchesScanned += 1;
      for (let page = 1; page <= MAX_COMMIT_PAGES; page += 1) {
        let commits;
        try {
          commits = await github.listCommits({
            owner,
            repo: name,
            sha: ref,
            since,
            until,
            per_page: PAGE_SIZE,
            page,
          });
        } catch (err) {
          if (err.status !== 409) {
            log(`commits ${repo.full_name}@${ref}: ${err.status || ''} ${err.message || err}`);
          }
          break;
        }
        if (!Array.isArray(commits) || !commits.length) break;

        for (const c of commits) {
          if (!c.sha || seenSha.has(c.sha)) continue;
          seenSha.add(c.sha);
          const { roles, identities } = matchCommitIdentities(c, { loginSet, aliases });
          if (!roles.length) continue;
          events.push(
            commitEvent(c, {
              roles,
              identities,
              repo: repo.full_name,
              branch: ref,
              foundVia: 'branch',
            })
          );
        }

        if (commits.length < PAGE_SIZE) break;
      }
    }

    return events;
  });

  return { events: perRepo.flat(), stats };
}

function scopeQualifiers(scopes) {
  return scopes
    .map((s) => `${s.type === 'Organization' ? 'org' : 'user'}:${s.login}`)
    .join(' ');
}

/** Local re-check so a name/email fragment can never pull in someone else. */
function commitMatchesAlias(commit, alias) {
  const needle = alias.toLowerCase();
  const author = commit.commit?.author || {};
  const committer = commit.commit?.committer || {};
  return [author.name, author.email, committer.name, committer.email]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

/**
 * Commits made under a git identity whose name/email contains an alias but
 * which is not linked to any of the known accounts.
 */
async function collectForAliases(github, aliases, scopes, period, { maxPages, record }) {
  const events = [];
  const rejected = [];
  if (!aliases.length || !scopes.length) return { events, rejected };

  const scopeQuery = scopeQualifiers(scopes);

  // GitHub matches author-email/committer-email exactly but tokenizes names, so
  // a full address searches the email fields and anything else searches names.
  const nameQualifiers = [
    { field: 'author-name', role: 'author', dateField: 'author-date' },
    { field: 'committer-name', role: 'committer', dateField: 'committer-date' },
  ];
  const emailQualifiers = [
    { field: 'author-email', role: 'author', dateField: 'author-date' },
    { field: 'committer-email', role: 'committer', dateField: 'committer-date' },
  ];

  for (const alias of aliases) {
    const identity = `name/email ~"${alias}"`;
    const qualifiers = alias.includes('@') ? emailQualifiers : nameQualifiers;
    for (const { field, role, dateField } of qualifiers) {
      const label = `${field}(${alias})`;
      const query = `${field}:${alias} ${dateField}:${period.dateRange} ${scopeQuery}`;

      let result;
      try {
        result = await record(label, query, (q) =>
          searchAll(
            label,
            (page) =>
              github.searchCommits({
                q,
                per_page: PAGE_SIZE,
                page,
                sort: dateField,
                order: 'desc',
              }),
            maxPages
          )
        );
      } catch (err) {
        // Unsupported qualifier / bad scope combination — skip, keep the rest.
        if (err instanceof GithubError && (err.status === 422 || err.status === 400)) {
          log(`${label}: skipped (${err.status} from search API)`);
          continue;
        }
        throw err;
      }

      for (const c of result.items) {
        if (!commitMatchesAlias(c, alias)) {
          rejected.push({
            sha: c.sha?.slice(0, 7),
            repo: repoOf(c),
            name: c.commit?.author?.name || null,
            email: c.commit?.author?.email || null,
          });
          continue;
        }
        events.push(commitEvent(c, { roles: [role], identities: [identity], foundVia: 'search' }));
      }
    }
  }

  if (rejected.length) {
    log(`alias searches discarded ${rejected.length} commit(s) that did not match locally`);
  }

  return { events, rejected };
}

/** Collapse duplicate SHAs / issue URLs, merging roles and matched identities. */
function dedupeEvents(events) {
  const byKey = new Map();

  for (const e of events) {
    const key = e.kind === 'commit' && e.sha ? `commit|${e.repo}|${e.sha}` : `${e.kind}|${e.url || e.title}`;
    const prev = byKey.get(key);

    if (!prev) {
      byKey.set(key, {
        ...e,
        identities: [...(e.identities || [])],
        branches: [...(e.branches || [])],
        foundVia: [...(e.foundVia || [])],
      });
      continue;
    }

    prev.identities = uniqueByLower([...(prev.identities || []), ...(e.identities || [])]);
    if (e.kind === 'commit') {
      const roles = [prev.role, e.role]
        .filter(Boolean)
        .flatMap((r) => String(r).split('+'))
        .filter(Boolean);
      prev.role = [...new Set(roles)].sort().join('+');
      prev.branches = uniqueByLower([...(prev.branches || []), ...(e.branches || [])]);
      prev.foundVia = [...new Set([...(prev.foundVia || []), ...(e.foundVia || [])])];
      if (Date.parse(e.at || 0) > Date.parse(prev.at || 0)) prev.at = e.at;
    }
  }

  return [...byKey.values()];
}

/**
 * A PR opened by one of our accounts this month is already reported as
 * pr_created; drop the weaker pr_updated/pr_involved rows for the same PR.
 */
function collapsePullKinds(events, ownLogins, period) {
  const created = new Set(
    events.filter((e) => e.kind === 'pr_created').map((e) => e.url).filter(Boolean)
  );

  return events.filter((e) => {
    if (e.kind !== 'pr_updated' && e.kind !== 'pr_involved') return true;
    if (created.has(e.url)) return false;
    const own = ownLogins.has(String(e.author || '').toLowerCase());
    return !(own && dateInMonth(e.createdAt, period.start, period.end));
  });
}

function groupByRepo(events) {
  const map = new Map();
  for (const e of events) {
    const repo = e.repo || 'unknown';
    if (!map.has(repo)) map.set(repo, []);
    map.get(repo).push(e);
  }
  return [...map.entries()]
    .map(([repo, list]) => ({
      repo,
      url: `https://github.com/${repo}`,
      activityCount: list.length,
      commitCount: list.filter((e) => e.kind === 'commit').length,
      prCount: list.filter((e) => e.kind.startsWith('pr_')).length,
      issueCount: list.filter((e) => e.kind.startsWith('issue_')).length,
      activity: list.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0)),
    }))
    .sort((a, b) => b.activityCount - a.activityCount || a.repo.localeCompare(b.repo));
}

/**
 * GitHub activity report for one calendar month, across every identity that
 * belongs to the user: the authenticated account, extra logins, and git
 * author/committer names or emails matching the configured aliases.
 *
 * @param {{
 *   month?: string|number,
 *   year?: string|number,
 *   text?: string,
 *   login?: string,
 *   logins?: string|string[],
 *   aliases?: string|string[],
 *   excludeOwners?: string|string[],
 *   allBranches?: boolean|string,
 *   maxPages?: number|string,
 * }} [payload]
 */
async function githubMonthlyActivityTask(payload = {}) {
  const period = resolveMonth({
    month: payload.month,
    year: payload.year,
    text: payload.text,
  });
  const maxPages = Math.min(
    Math.max(Number(payload.maxPages) || DEFAULT_MAX_PAGES, 1),
    DEFAULT_MAX_PAGES
  );

  const github = createGithubClient();
  const me = await github.getAuthenticatedUser();

  const primary = String(payload.login || me.login || '').trim();
  if (!primary) throw new Error('GitHub /user did not return login');

  const extraLogins = payload.logins !== undefined
    ? toList(payload.logins)
    : config.GITHUB_ACTIVITY_LOGINS;
  const logins = uniqueByLower([primary, ...extraLogins]);

  const aliases = (
    payload.aliases !== undefined ? toList(payload.aliases) : config.GITHUB_ACTIVITY_ALIASES
  )
    .map((a) => a.toLowerCase())
    .slice(0, MAX_ALIASES);

  const excludedOwners = new Set(
    (payload.excludeOwners !== undefined
      ? toList(payload.excludeOwners)
      : config.GITHUB_ACTIVITY_EXCLUDE_OWNERS
    ).map((o) => o.toLowerCase())
  );
  const isExcludedOwner = (owner) => excludedOwners.has(String(owner || '').toLowerCase());
  const isExcludedRepo = (fullName) => isExcludedOwner(String(fullName || '').split('/')[0]);

  const allBranches =
    payload.allBranches !== undefined
      ? !['false', 'no', '0', 'off'].includes(String(payload.allBranches).toLowerCase())
      : config.GITHUB_ACTIVITY_ALL_BRANCHES;

  const queries = {};
  const totals = {};
  let anyTruncated = false;

  const record = async (label, query, exec) => {
    queries[label] = query;
    const res = await exec(query);
    totals[label] = res.totalCount;
    if (res.truncated) anyTruncated = true;
    await sleep(SEARCH_GAP_MS);
    return res;
  };

  log(`${period.label} for ${logins.map((l) => `@${l}`).join(', ')}`);

  const rawEvents = [];
  for (const login of logins) {
    rawEvents.push(...(await collectForLogin(github, login, period, { maxPages, record })));
  }

  const needsRepoList = aliases.length > 0 || allBranches;
  const accessibleRepos = needsRepoList ? await loadAccessibleRepos(github) : [];

  let scopes = [];
  let rejectedAliasCommits = [];
  if (aliases.length) {
    scopes = resolveSearchScopes(accessibleRepos, logins, isExcludedOwner);
    log(
      `alias identities ${aliases.map((a) => `"${a}"`).join(', ')} scoped to ${scopeQualifiers(scopes) || '(none)'}`
    );
    const aliasResult = await collectForAliases(github, aliases, scopes, period, {
      maxPages,
      record,
    });
    rawEvents.push(...aliasResult.events);
    rejectedAliasCommits = aliasResult.rejected;
  }

  const ownLogins = new Set(logins.map((l) => l.toLowerCase()));

  let branchStats = null;
  if (allBranches) {
    // A repo whose last push predates the month cannot hold in-month commits.
    const branchCandidates = accessibleRepos.filter(
      (r) =>
        !isExcludedRepo(r.full_name) &&
        (!r.pushed_at || String(r.pushed_at).slice(0, 10) >= period.start)
    );
    log(`branch sweep over ${branchCandidates.length} recently-pushed repo(s)`);
    const branchResult = await collectFromBranches(github, branchCandidates, period, {
      loginSet: ownLogins,
      aliases,
    });
    rawEvents.push(...branchResult.events);
    branchStats = branchResult.stats;
    log(
      `branch sweep: ${branchResult.events.length} commit hit(s) across ${branchStats.branchesScanned} branch(es)`
    );
  }

  const events = collapsePullKinds(dedupeEvents(rawEvents), ownLogins, period)
    .filter((e) => !isExcludedRepo(e.repo))
    .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));

  const repos = groupByRepo(events);

  const byKind = {};
  const byIdentity = {};
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    for (const id of e.identities || []) byIdentity[id] = (byIdentity[id] || 0) + 1;
  }

  const aliasOnlyEvents = events.filter(
    (e) => (e.identities || []).length && (e.identities || []).every((id) => id.startsWith('name/email'))
  );

  const matchedGitIdentities = uniqueByLower(
    aliasOnlyEvents
      .map((e) => `${e.authorName || '?'} <${e.authorEmail || '?'}>`)
      .filter(Boolean)
  );

  const branchOnlyEvents = events.filter(
    (e) => e.kind === 'commit' && (e.foundVia || []).length === 1 && e.foundVia[0] === 'branch'
  );

  return {
    reportType: 'github-monthly-activity',
    month: period.label,
    slug: period.slug,
    range: { start: period.start, end: period.end },
    monthDefaulted: Boolean(period.defaulted),
    user: {
      login: primary,
      name: me.name || null,
      html_url: me.html_url || null,
    },
    identities: {
      logins,
      aliases,
      aliasScopes: scopes.map((s) => `${s.type === 'Organization' ? 'org' : 'user'}:${s.login}`),
      matchedGitIdentities,
      aliasOnlyEventCount: aliasOnlyEvents.length,
      rejectedAliasCommitCount: rejectedAliasCommits.length,
      excludedOwners: [...excludedOwners],
    },
    branchCoverage: {
      enabled: allBranches,
      reposScanned: branchStats?.reposScanned ?? 0,
      branchesScanned: branchStats?.branchesScanned ?? 0,
      offDefaultBranchCommits: branchOnlyEvents.length,
      reposCapped: Boolean(branchStats?.reposCapped),
      branchesCapped: Boolean(branchStats?.branchesCapped),
    },
    queries,
    searchTotals: totals,
    truncated: anyTruncated,
    eventCount: events.length,
    repoCount: repos.length,
    stats: { byKind, byIdentity },
    repos,
    generatedAt: new Date().toISOString(),
  };
}

function kindSummaryLine(byKind) {
  const parts = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`);
  return parts.length ? parts.join(', ') : 'no events';
}

function identityLine(identities = {}) {
  const parts = (identities.logins || []).map((l) => `@${l}`);
  for (const a of identities.aliases || []) parts.push(`name/email ~"${a}"`);
  return parts.join(', ');
}

/** Compact chat-friendly summary. */
function formatResult(result, { maxRepos = 10, maxEventsPerRepo = 4 } = {}) {
  const ids = result.identities || {};
  const lines = [
    `GitHub activity — ${result.month}`,
    `Identities: ${identityLine(ids)}`,
    `${result.eventCount} event(s) across ${result.repoCount} repo(s): ${kindSummaryLine(result.stats?.byKind || {})}`,
  ];

  if (!result.eventCount) {
    lines.push(`No GitHub activity found for ${result.month}.`);
    return lines.join('\n');
  }

  if (ids.aliasOnlyEventCount) {
    lines.push(
      `${ids.aliasOnlyEventCount} event(s) came only from unlinked git identities: ${ids.matchedGitIdentities.join(', ')}`
    );
  }
  const branch = result.branchCoverage || {};
  if (branch.enabled && branch.offDefaultBranchCommits) {
    lines.push(
      `${branch.offDefaultBranchCommits} commit(s) live only on non-default branches (${branch.branchesScanned} branches swept).`
    );
  }

  lines.push('');
  for (const group of result.repos.slice(0, maxRepos)) {
    lines.push(`• ${group.repo} — ${group.activityCount} event(s)`);
    for (const e of group.activity.slice(0, maxEventsPerRepo)) {
      lines.push(`  ${fmtStamp(e.at)} [${e.kind}] ${e.title}`);
    }
    if (group.activity.length > maxEventsPerRepo) {
      lines.push(`  …and ${group.activity.length - maxEventsPerRepo} more in this repo.`);
    }
  }
  if (result.repos.length > maxRepos) {
    lines.push(`…and ${result.repos.length - maxRepos} more repo(s).`);
  }
  if (result.truncated) {
    lines.push('(Some searches hit the GitHub result cap — counts may be partial.)');
  }
  return lines.join('\n');
}

/** Full per-repo timeline — used by the CLI/script report. */
function formatFullReport(result) {
  const u = result.user || {};
  const ids = result.identities || {};
  const lines = [
    `GitHub activity — ${result.month}`,
    `User: ${u.name || u.login} (@${u.login})`,
    `Identities searched: ${identityLine(ids)}`,
  ];
  if (ids.aliases?.length) {
    lines.push(`Alias scope: ${ids.aliasScopes?.join(' ') || '(none — alias search skipped)'}`);
    if (ids.matchedGitIdentities?.length) {
      lines.push(`Unlinked git identities matched: ${ids.matchedGitIdentities.join(', ')}`);
    }
    if (ids.rejectedAliasCommitCount) {
      lines.push(`Discarded ${ids.rejectedAliasCommitCount} alias hit(s) that failed local verification.`);
    }
  }
  if (ids.excludedOwners?.length) {
    lines.push(`Excluded owners: ${ids.excludedOwners.join(', ')}`);
  }
  const branch = result.branchCoverage || {};
  lines.push(
    branch.enabled
      ? `Branch coverage: all branches — ${branch.branchesScanned} branch(es) across ${branch.reposScanned} repo(s); ${branch.offDefaultBranchCommits} commit(s) off the default branch${branch.reposCapped || branch.branchesCapped ? ' (scan caps hit)' : ''}`
      : 'Branch coverage: default branches only (search API)'
  );
  lines.push(`Range: ${result.range.start}..${result.range.end}`);
  lines.push(`Events: ${result.eventCount} across ${result.repoCount} repo(s)`);
  lines.push('');
  lines.push('Search hits:');
  for (const [k, n] of Object.entries(result.searchTotals || {})) {
    lines.push(`  ${k}: ${n}`);
  }
  lines.push('');

  if (!result.eventCount) {
    lines.push(`No activity found for ${result.month}.`);
    return lines.join('\n');
  }

  lines.push('Summary by kind:');
  for (const [kind, n] of Object.entries(result.stats.byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind}: ${n}`);
  }
  lines.push('');
  lines.push('Summary by identity:');
  for (const [id, n] of Object.entries(result.stats.byIdentity || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${id}: ${n}`);
  }
  lines.push('');

  for (const group of result.repos) {
    lines.push(
      `── ${group.repo} (${group.activityCount} event${group.activityCount === 1 ? '' : 's'})`
    );
    lines.push(`   ${group.url}`);
    for (const e of group.activity) {
      const extra = e.kind === 'commit' ? `${e.sha} (${e.role})` : e.state ? `[${e.state}]` : '';
      const who = e.author && !ids.logins?.some((l) => l.toLowerCase() === String(e.author).toLowerCase())
        ? ` by @${e.author}`
        : '';
      lines.push(`   ${fmtStamp(e.at)}  [${e.kind}]  ${e.title}${who}${extra ? ` ${extra}` : ''}`);
      if (e.kind === 'commit' && (e.identities || []).every((id) => id.startsWith('name/email'))) {
        lines.push(`      git identity: ${e.authorName || '?'} <${e.authorEmail || '?'}>`);
      }
      if (e.kind === 'commit' && (e.foundVia || []).length === 1 && e.foundVia[0] === 'branch') {
        lines.push(`      branch: ${(e.branches || []).join(', ') || '?'}`);
      }
      if (e.url) lines.push(`      ${e.url}`);
    }
    lines.push('');
  }

  if (result.truncated) {
    lines.push('Note: at least one search hit the GitHub result cap; counts may be partial.');
  }

  return lines.join('\n').trimEnd();
}

module.exports = githubMonthlyActivityTask;
module.exports.formatResult = formatResult;
module.exports.formatFullReport = formatFullReport;
