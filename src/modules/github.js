const registry = require('../core/moduleRegistry');
const githubSearchReposTask = require('../tasks/githubSearchRepos');
const githubListReposTask = require('../tasks/githubListRepos');
const githubListTagsTask = require('../tasks/githubListTags');
const githubCreateTagTask = require('../tasks/githubCreateTag');
const githubSearchPrsTask = require('../tasks/githubSearchPrs');
const githubGetPrTask = require('../tasks/githubGetPr');
const githubMonthlyActivityTask = require('../tasks/githubMonthlyActivity');
const repoInfo = require('../tasks/githubRepoInfo');
const githubIssues = require('../tasks/githubIssues');
const { parseGithubUrl } = require('../integrations/githubClient');
const { looksLikeMonthlyActivity } = require('../util/monthRange');
const { stageOrExecute } = require('../util/mutatingGate');
const { runLocalTask } = require('../util/runLocalTask');

const READ_TOOLS = [
  'github_search_repos',
  'github_list_repos',
  'github_get_repo',
  'github_list_tags',
  'github_list_branches',
  'github_list_commits',
  'github_compare',
  'github_get_file',
  'github_search_prs',
  'github_get_pr',
  'github_search_issues',
  'github_get_issue',
  'github_monthly_activity',
];

const WRITE_TOOLS = ['github_create_tag', 'github_add_comment', 'github_create_issue'];

const TAG_MUTATE_RE = /\b(create|make|add|push)\b.{0,40}\btag\b/i;
const COMMENT_MUTATE_RE = /\b(comment on|reply (to|on)|post (a )?comment|leave (a )?comment)\b.{0,60}\b(pr|pull request|#\d+|issue)\b/i;
const ISSUE_MUTATE_RE = /\b(create|open|file|raise)\b.{0,30}\b(github|gh)\s+issue\b|\b(create|open|file|raise)\b.{0,20}\bissue\b.{0,20}\b(in|on)\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i;
const COMPARE_RE = /\b(compare|diff between|what('s| has)? changed|changes since|since (v?\d[\w.-]*|the last (tag|release))|unreleased)\b/i;
/** "in owner/repo" — a repo named in prose, not a URL. */
const REPO_SLUG_RE = /\b(in|on|for|from|of)\s+[A-Za-z0-9_.-]{2,}\/[A-Za-z0-9_.-]{2,}\b/;
const VERSION_SINCE_RE = /\bsince\s+v?\d+\.\d+/i;
const PR_FOLLOW_UP_RE = /\b(ci|checks?|builds?|pipeline|tests? (pass|fail)|merged|mergeable|reviews?|approved|reviewers?|files?|diff|commits?|comments?|conflicts?)\b/i;

const WRITE_EXECUTORS = {
  github_create_tag: (a) =>
    runLocalTask('github-create-tag', githubCreateTagTask, githubCreateTagTask.formatResult, {
      repo: a.repo,
      owner: a.owner,
      tag: a.tag,
      sha: a.sha,
      branch: a.branch || a.ref,
      message: a.message,
    }),
  github_add_comment: (a) =>
    runLocalTask('github-add-comment', githubIssues.addComment, githubIssues.formatAddComment, {
      repo: a.repo,
      number: a.number,
      body: a.body,
    }),
  github_create_issue: (a) =>
    runLocalTask('github-create-issue', githubIssues.createIssue, githubIssues.formatCreateIssue, {
      repo: a.repo,
      title: a.title,
      body: a.body,
      labels: a.labels,
      assignees: a.assignees,
    }),
};

function looksLikeGithub(text) {
  const t = String(text || '');
  return (
    Boolean(parseGithubUrl(t)) ||
    /\b(github|gh\b)\b/i.test(t) ||
    /\b(repos?|repositories)\b/i.test(t) ||
    /\b(pull requests?|\bPRs?\b)\b/i.test(t) ||
    /\b(git\s+)?tags?\b/i.test(t) ||
    /\bcommits?\b/i.test(t) ||
    /\bbranch(es)?\b/i.test(t) ||
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/.test(t) ||
    REPO_SLUG_RE.test(t) ||
    VERSION_SINCE_RE.test(t)
  );
}

/**
 * Most recent GitHub PR/issue/repo reference in conversation history (newest last):
 * a github.com URL or owner/repo#N.
 * @param {{ content?: string }[]} history
 * @returns {{ full_name: string, number: number|null, kind: string } | null}
 */
function lastGithubRefFromHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const text = String(history[i]?.content || '');
    const shorthand = [...text.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g)].pop();
    if (shorthand) return { full_name: shorthand[1], number: Number(shorthand[2]), kind: 'pull' };
    const url = parseGithubUrl(text);
    if (url?.full_name) return { full_name: url.full_name, number: url.number ?? null, kind: url.kind };
  }
  return null;
}

function intentFromGithubUrl(ghUrl) {
  if (!ghUrl || ghUrl.kind === 'site') return null;
  return {
    domain: 'github',
    mode: 'lookup',
    budget: 'fast',
    confidence: 'high',
    reason: 'github-url',
    forceGithub: true,
    githubUrl: ghUrl,
  };
}

registry.register({
  id: 'github',

  mutatingTools: WRITE_TOOLS,

  selectTools: (intent, ctx) => {
    const direct =
      intent.domain === 'github' ||
      intent.domain === 'mixed' ||
      intent.forceGithubMonthlyActivity ||
      intent.forceGithub;
    const names = [];
    if (direct || ctx.fallback) names.push(...READ_TOOLS);
    if (direct && ctx.writes) names.push(...WRITE_TOOLS);
    return names;
  },

  intent: (text, ctx = {}) => {
    const t = String(text || '').trim();
    const ghUrl = parseGithubUrl(t);
    const ref = ctx.lastGithubRef || null;

    // "what about its CI?" / "is it merged?" right after a PR was discussed
    if (
      !ghUrl &&
      ref?.number &&
      ref.kind === 'pull' &&
      PR_FOLLOW_UP_RE.test(t) &&
      /\b(it|its|that|this|the pr|the pull request)\b/i.test(t) &&
      !/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(t) &&
      !/\b[A-Z][A-Z0-9]+-\d+\b/.test(t)
    ) {
      return {
        domain: 'github',
        mode: 'lookup',
        budget: 'fast',
        confidence: 'high',
        reason: 'github-pr-follow-up',
        forceGithub: true,
        githubUrl: { kind: 'pull', full_name: ref.full_name, number: ref.number },
      };
    }

    if (!looksLikeGithub(t)) return null;

    // "my GitHub activity for July 2026" — month report beats repo/PR lookups.
    const monthly = looksLikeMonthlyActivity(t);
    if (monthly && /\b(github|gh|commits?|prs?|pull requests?)\b/i.test(t)) {
      return {
        domain: 'github',
        mode: 'activity',
        budget: 'slow',
        confidence: 'high',
        reason: 'monthly-activity',
        forceGithubMonthlyActivity: true,
        monthRef: monthly.monthRef ? monthly.monthRef.source : null,
      };
    }

    const mutate = TAG_MUTATE_RE.test(t) || COMMENT_MUTATE_RE.test(t) || ISSUE_MUTATE_RE.test(t);
    const fromUrl = !mutate ? intentFromGithubUrl(ghUrl) : null;
    if (fromUrl) return fromUrl;

    // Prefer explicit github / PR / tag / repo language over generic "repo"
    const strong =
      /\b(github|gh\b|pull requests?|\bPRs?\b|git\s+tags?|create\s+tag|list\s+repos?|search\s+repos?|branches)\b/i.test(
        t
      ) ||
      /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/.test(t) ||
      REPO_SLUG_RE.test(t) ||
      VERSION_SINCE_RE.test(t);

    if (!strong && !/\b(github|gh\b)\b/i.test(t) && !ghUrl) {
      // "repos" alone is weak — only claim github if paired with search/list/tag
      if (!/\b(search|list|find|show|check|create|compare).{0,40}\b(repos?|tags?|branch(es)?|commits?)\b/i.test(t)) {
        return null;
      }
    }

    return {
      domain: 'github',
      mode: mutate ? 'mutate' : 'lookup',
      needsConfirm: mutate,
      budget: 'fast',
      confidence: strong || ghUrl ? 'high' : 'medium',
      reason: mutate ? 'github-mutate' : 'github-lookup',
      githubUrl: ghUrl || undefined,
    };
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'github_search_repos',
        description: 'Search GitHub repositories by query (name, topic, language, user:, org:). For one known repo use github_get_repo.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'GitHub search query' },
            max: { type: 'integer', description: 'Max results (default 10, max 50)' },
            sort: { type: 'string', description: 'stars | forks | help-wanted-issues | updated' },
            order: { type: 'string', enum: ['asc', 'desc'] },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_list_repos',
        description:
          'List repositories for the authenticated user, or for an organization if org is set.',
        parameters: {
          type: 'object',
          properties: {
            org: { type: 'string', description: 'Optional org login to list org repos' },
            type: {
              type: 'string',
              description: 'all | owner | public | private | member (user) / all|public|private|forks|sources|member (org)',
            },
            max: { type: 'integer', description: 'Max repos (default 30)' },
            sort: { type: 'string', description: 'created | updated | pushed | full_name' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_get_repo',
        description: 'Details for one repo: description, default branch, language, topics, last push; optional README excerpt.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com URL' },
            include_readme: { type: 'boolean', description: 'Include a README excerpt (default false)' },
          },
          required: ['repo'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_list_tags',
        description:
          'List tags on a repo. Optionally check whether a specific tag exists (tag=).',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com URL' },
            owner: { type: 'string' },
            tag: { type: 'string', description: 'Optional tag name to check existence' },
            max: { type: 'integer', description: 'Max tags to list (default 30)' },
          },
          required: ['repo'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_list_branches',
        description: 'List branches on a repo, optionally filtered by a name fragment (e.g. a Jira key).',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com URL' },
            filter: { type: 'string', description: 'Case-insensitive name fragment' },
            max: { type: 'integer', description: 'Max branches (default 50)' },
          },
          required: ['repo'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_list_commits',
        description:
          'Recent commits on a branch/tag/SHA (default branch if omitted), optionally filtered by author, path, or date window. Sees every branch, unlike search.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com URL' },
            branch: { type: 'string', description: 'Branch, tag, or SHA' },
            author: { type: 'string', description: 'GitHub login or email' },
            path: { type: 'string', description: 'Only commits touching this path' },
            since: { type: 'string', description: 'ISO 8601 date/time' },
            until: { type: 'string', description: 'ISO 8601 date/time' },
            max: { type: 'integer', description: 'Max commits (default 20, max 100)' },
          },
          required: ['repo'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_compare',
        description:
          'Compare two refs (base...head): commits, changed files, ahead/behind, and the Jira issues referenced in commit messages. Use for "what changed since v1.2.0", "what\'s unreleased", release notes. head defaults to the default branch.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com URL' },
            base: { type: 'string', description: 'Older ref: tag, branch, or SHA (e.g. the last release tag)' },
            head: { type: 'string', description: 'Newer ref (default: default branch)' },
          },
          required: ['repo', 'base'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_get_file',
        description: 'Read a file (or list a directory) from a repo at a ref. Use for READMEs, configs, package.json, workflows.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com URL' },
            path: { type: 'string', description: 'File or directory path (empty = repo root)' },
            ref: { type: 'string', description: 'Branch, tag, or SHA (default branch if omitted)' },
          },
          required: ['repo'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_search_prs',
        description:
          'Search pull requests, or list PRs for a repo when only repo is given. GitHub search syntax: repo:, org:, is:open, author:@me, review-requested:@me, involves:@me, label:, head:<branch>.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'PR search query (type:pr added automatically)' },
            repo: { type: 'string', description: 'owner/repo or a github.com URL — list or scope search' },
            state: { type: 'string', description: 'open | closed | merged | all' },
            max: { type: 'integer', description: 'Max results (default 10)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_get_pr',
        description:
          'Read a single pull request: title, body, state, diff stats, CI checks, reviews, and Jira issues it references. Prefer this over web_fetch_page for github.com/…/pull/N links; repo may be owner/repo or a github.com URL.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com pull/repo URL' },
            number: { type: 'integer', description: 'PR number (optional if the github.com URL includes /pull/N)' },
            include: {
              type: 'string',
              description: 'Comma-separated extras: checks, reviews, files, commits, comments, all, none (default checks,reviews)',
            },
          },
          required: ['repo'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_search_issues',
        description: 'Search GitHub issues (not PRs). Syntax: repo:, org:, is:open, label:, assignee:@me, author:.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Issue search query (is:issue added automatically)' },
            repo: { type: 'string', description: 'owner/repo to scope the search' },
            state: { type: 'string', enum: ['open', 'closed', 'all'] },
            max: { type: 'integer', description: 'Max results (default 10)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_get_issue',
        description: 'Read one GitHub issue by repo and number, with recent comments.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com issue URL' },
            number: { type: 'integer', description: 'Issue number (optional if the URL includes it)' },
          },
          required: ['repo'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_monthly_activity',
        description:
          'Full GitHub activity report over ONE calendar month: commits authored/committed on ALL branches (not just default ones), PRs opened/updated/reviewed, issues, and comments, grouped by repository. Covers every identity belonging to the user (the auth account, extra logins, and unlinked git author/committer names or emails) — no need to pass logins or aliases. Use for "what did I ship in July", "my GitHub activity last month", monthly recaps.',
        parameters: {
          type: 'object',
          properties: {
            month: {
              type: 'string',
              description:
                'Month as YYYY-MM (e.g. 2026-07), "July 2026", "last month", or "this month". Defaults to the current month.',
            },
            year: { type: 'integer', description: 'Optional year if month is a bare name' },
            login: {
              type: 'string',
              description: 'Primary GitHub login to report on (defaults to the auth user)',
            },
            logins: {
              type: 'string',
              description:
                'Comma-separated extra GitHub logins to include. Omit to use the configured defaults.',
            },
            aliases: {
              type: 'string',
              description:
                'Comma-separated git author/committer name or email fragments to include. Omit to use the configured defaults.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_create_tag',
        description:
          'Create a git tag on a repo at a commit SHA or branch (default HEAD/default branch). Annotated if message is set.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com URL' },
            tag: { type: 'string', description: 'Tag name (e.g. v1.2.0)' },
            sha: { type: 'string', description: 'Commit SHA (optional if branch/ref given)' },
            branch: { type: 'string', description: 'Branch or ref to tag (default HEAD)' },
            message: { type: 'string', description: 'Optional annotation message' },
          },
          required: ['repo', 'tag'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_add_comment',
        description: 'Post a comment on a GitHub PR or issue conversation (markdown).',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo or a github.com PR/issue URL' },
            number: { type: 'integer', description: 'PR or issue number' },
            body: { type: 'string', description: 'Comment text (markdown)' },
          },
          required: ['repo', 'body'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_create_issue',
        description: 'Open a GitHub issue in a repo.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo' },
            title: { type: 'string' },
            body: { type: 'string', description: 'Markdown body' },
            labels: { type: 'string', description: 'Comma-separated labels' },
            assignees: { type: 'string', description: 'Comma-separated GitHub logins' },
          },
          required: ['repo', 'title'],
        },
      },
    },
  ],

  tasks: {
    'github-search-repos': {
      execute: githubSearchReposTask,
      format: githubSearchReposTask.formatResult,
    },
    'github-list-repos': {
      execute: githubListReposTask,
      format: githubListReposTask.formatResult,
    },
    'github-list-tags': {
      execute: githubListTagsTask,
      format: githubListTagsTask.formatResult,
    },
    'github-create-tag': {
      execute: githubCreateTagTask,
      format: githubCreateTagTask.formatResult,
    },
    'github-search-prs': {
      execute: githubSearchPrsTask,
      format: githubSearchPrsTask.formatResult,
    },
    'github-get-pr': {
      execute: githubGetPrTask,
      format: githubGetPrTask.formatResult,
    },
    'github-monthly-activity': {
      execute: githubMonthlyActivityTask,
      format: githubMonthlyActivityTask.formatResult,
    },
    'github-compare': { execute: repoInfo.compare, format: repoInfo.formatCompare },
  },

  toolHandlers: {
    github_search_repos: async (args) =>
      runLocalTask('github-search-repos', githubSearchReposTask, githubSearchReposTask.formatResult, {
        query: args.query,
        max: args.max,
        sort: args.sort,
        order: args.order,
      }),
    github_list_repos: async (args) =>
      runLocalTask('github-list-repos', githubListReposTask, githubListReposTask.formatResult, {
        org: args.org,
        type: args.type,
        max: args.max,
        sort: args.sort,
      }),
    github_get_repo: async (args) =>
      runLocalTask('github-get-repo', repoInfo.getRepo, repoInfo.formatGetRepo, {
        repo: args.repo,
        include_readme: args.include_readme,
      }),
    github_list_tags: async (args) =>
      runLocalTask('github-list-tags', githubListTagsTask, githubListTagsTask.formatResult, {
        repo: args.repo,
        owner: args.owner,
        tag: args.tag,
        max: args.max,
      }),
    github_list_branches: async (args) =>
      runLocalTask('github-list-branches', repoInfo.listBranches, repoInfo.formatListBranches, {
        repo: args.repo,
        filter: args.filter,
        max: args.max,
      }),
    github_list_commits: async (args) =>
      runLocalTask('github-list-commits', repoInfo.listCommits, repoInfo.formatListCommits, {
        repo: args.repo,
        branch: args.branch,
        author: args.author,
        path: args.path,
        since: args.since,
        until: args.until,
        max: args.max,
      }),
    github_compare: async (args) =>
      runLocalTask('github-compare', repoInfo.compare, repoInfo.formatCompare, {
        repo: args.repo,
        base: args.base,
        head: args.head,
      }),
    github_get_file: async (args) =>
      runLocalTask('github-get-file', repoInfo.getFile, repoInfo.formatGetFile, {
        repo: args.repo,
        path: args.path,
        ref: args.ref,
      }),
    github_search_prs: async (args) =>
      runLocalTask('github-search-prs', githubSearchPrsTask, githubSearchPrsTask.formatResult, {
        query: args.query,
        repo: args.repo,
        state: args.state,
        max: args.max,
        sort: args.sort,
        order: args.order,
      }),
    github_get_pr: async (args) =>
      runLocalTask('github-get-pr', githubGetPrTask, githubGetPrTask.formatResult, {
        repo: args.repo,
        owner: args.owner,
        number: args.number,
        include: args.include,
      }),
    github_search_issues: async (args) =>
      runLocalTask('github-search-issues', githubIssues.searchIssues, githubIssues.formatSearchIssues, {
        query: args.query,
        repo: args.repo,
        state: args.state,
        max: args.max,
      }),
    github_get_issue: async (args) =>
      runLocalTask('github-get-issue', githubIssues.getIssue, githubIssues.formatGetIssue, {
        repo: args.repo,
        number: args.number,
      }),
    github_monthly_activity: async (args) =>
      runLocalTask(
        'github-monthly-activity',
        githubMonthlyActivityTask,
        githubMonthlyActivityTask.formatResult,
        {
          month: args.month,
          year: args.year,
          login: args.login,
          logins: args.logins,
          aliases: args.aliases,
        }
      ),
    ...Object.fromEntries(
      WRITE_TOOLS.map((name) => [
        name,
        (args, discordCtx) =>
          stageOrExecute(name, args, discordCtx, () => WRITE_EXECUTORS[name](args), { domainLabel: 'GitHub' }),
      ])
    ),
  },

  promptPack: () =>
    [
      'GitHub mode:',
      '- Use github_* tools for repos, branches, commits, tags, PRs, and issues. Do not invent repo/PR data.',
      '- If the user gives a github.com link, use github_* tools (the GitHub client). Never web_fetch_page or scrape github.com.',
      '- PR URLs (…/pull/N) → github_get_pr. Issue URLs (…/issues/N) → github_get_issue. Repo URLs → github_get_repo.',
      '- Repo args are owner/repo (e.g. octocat/Hello-World) or a github.com URL. If none is named, use the workspace default repos.',
      '- CI / checks / reviews on a PR → github_get_pr (checks and reviews are included by default; add include=files or commits when asked).',
      '- "What changed since vX" / unreleased work / release notes → github_compare (list tags first if the base tag is unknown).',
      '- Recent commits on a branch → github_list_commits. Branches → github_list_branches. Read a file/README → github_get_file.',
      '- PRs awaiting my review → github_search_prs query="review-requested:@me is:open". My open PRs → "author:@me is:open".',
      '- List my repos → github_list_repos. Search the catalog → github_search_repos.',
      '- Check/list tags → github_list_tags (set tag= to check existence).',
      `- Writes (${WRITE_TOOLS.join(', ')}) are gated when confirmation is on.`,
      '- Past-period questions ("what did I ship in July", "activity last month") → github_monthly_activity.',
      '- When a PR references Jira issues, mention them with their status. Cite html_url from tool results.',
    ].join('\n'),

  buildPlan: (intent, userText, opts, pushTool) => {
    if (intent.domain !== 'github' && intent.domain !== 'mixed') return;
    const t = String(userText || '');

    if (intent.forceGithubMonthlyActivity) {
      pushTool(
        'github_monthly_activity',
        `Month activity report${intent.monthRef ? ` for ${intent.monthRef}` : ''}`
      );
      return;
    }
    if (TAG_MUTATE_RE.test(t)) {
      pushTool('github_create_tag', 'Create the requested git tag (propose if gated)');
      return;
    }
    if (COMMENT_MUTATE_RE.test(t)) {
      pushTool('github_add_comment', 'Post the requested comment (propose if gated)');
      return;
    }
    if (ISSUE_MUTATE_RE.test(t)) {
      pushTool('github_create_issue', 'Open the requested GitHub issue (propose if gated)');
      return;
    }
    const ghUrl = intent.githubUrl || parseGithubUrl(t);
    if (ghUrl && ghUrl.kind !== 'site') {
      if (ghUrl.kind === 'pull' && ghUrl.number) {
        pushTool('github_get_pr', `Fetch ${ghUrl.full_name}#${ghUrl.number} via the GitHub client`);
        return;
      }
      if (ghUrl.kind === 'issue' && ghUrl.number) {
        pushTool('github_get_issue', `Fetch ${ghUrl.full_name}#${ghUrl.number} via the GitHub client`);
        return;
      }
      if (ghUrl.kind === 'tags' && ghUrl.full_name) {
        pushTool('github_list_tags', `List tags on ${ghUrl.full_name} via the GitHub client`);
        return;
      }
      if (ghUrl.kind === 'commit' && ghUrl.full_name) {
        pushTool('github_list_commits', `Look up commit ${ghUrl.sha || ''} on ${ghUrl.full_name}`);
        return;
      }
      if ((ghUrl.kind === 'org' || ghUrl.kind === 'user') && ghUrl.owner) {
        pushTool('github_list_repos', `List repos for ${ghUrl.owner} via the GitHub client`);
        return;
      }
      if (ghUrl.full_name && /\b(pr|pull)\b/i.test(t)) {
        pushTool('github_search_prs', `Search PRs in ${ghUrl.full_name} via the GitHub client`);
        return;
      }
      if (ghUrl.full_name) {
        pushTool('github_get_repo', `Look up ${ghUrl.full_name} via the GitHub client (not web fetch)`);
        return;
      }
    }
    if (COMPARE_RE.test(t)) {
      pushTool('github_compare', 'Compare refs (list tags first if the base is unknown)');
      return;
    }
    if (/\btags?\b/i.test(t) && /\b(list|check|show|get|what)\b/i.test(t)) {
      pushTool('github_list_tags', 'List or check tags on the repo');
      return;
    }
    if (/\bbranch(es)?\b/i.test(t)) {
      pushTool('github_list_branches', 'List branches on the repo');
      return;
    }
    const prMatch = t.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/);
    if (prMatch || (/\b(pr|pull)\b/i.test(t) && /#?\d+/.test(t) && /\bread|show|get|details?|ci|checks?|status\b/i.test(t))) {
      pushTool('github_get_pr', 'Fetch the pull request details');
      return;
    }
    if (/\b(pull requests?|\bPRs?\b)\b/i.test(t)) {
      pushTool('github_search_prs', 'Search or list pull requests');
      return;
    }
    if (/\bcommits?\b/i.test(t)) {
      pushTool('github_list_commits', 'List recent commits');
      return;
    }
    if (/\bgithub\s+issues?\b|\bissues?\s+(in|on)\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i.test(t)) {
      pushTool('github_search_issues', 'Search GitHub issues');
      return;
    }
    if (/\b(list|show|my)\b.{0,30}\brepos?\b/i.test(t) && !/\bsearch\b/i.test(t)) {
      pushTool('github_list_repos', 'List repositories for the auth user or org');
      return;
    }
    if (/\b(search|find)\b.{0,40}\brepos?\b/i.test(t) || /\bgithub\b.*\bsearch\b/i.test(t)) {
      pushTool('github_search_repos', 'Search GitHub repositories');
      return;
    }
    pushTool('github_list_repos', 'List accessible repositories');
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    const d = envelope.data || {};
    if (tool === 'github_search_repos' || tool === 'github_list_repos') {
      const repos = d.repos || [];
      for (const r of repos.slice(0, 30)) {
        out.push({
          type: 'repo',
          full_name: r.full_name,
          url: r.html_url,
          private: r.private,
          stars: r.stars,
        });
      }
    }
    if (tool === 'github_get_repo' && d.full_name) {
      out.push({ type: 'repo', full_name: d.full_name, url: d.html_url, private: d.private });
    }
    if (tool === 'github_list_tags') {
      if (d.check) {
        out.push({ type: 'tag_check', tag: d.check.tag, exists: d.check.exists, sha: d.check.sha });
      }
      for (const t of (d.tags || []).slice(0, 40)) {
        out.push({ type: 'tag', name: t.name, sha: t.sha });
      }
    }
    if (tool === 'github_list_branches') {
      for (const b of (d.branches || []).slice(0, 40)) out.push({ type: 'branch', name: b.name });
    }
    if (tool === 'github_list_commits' || tool === 'github_compare') {
      if (tool === 'github_compare') {
        out.push({ type: 'compare', base: d.base, head: d.head, ahead_by: d.ahead_by, url: d.html_url });
      }
      for (const c of (d.commits || []).slice(-30)) {
        out.push({ type: 'commit', sha: c.sha?.slice(0, 7), message: c.message });
      }
      for (const i of d.jiraIssues || []) {
        out.push({ type: 'issue', key: i.key, summary: i.summary, status: i.status, browseUrl: i.browseUrl });
      }
    }
    if (tool === 'github_get_file' && d.path) {
      out.push({ type: 'file', path: `${d.full_name}/${d.path}`, url: d.html_url || null });
    }
    if (tool === 'github_create_tag' && d.tag) {
      out.push({ type: 'side_effect', value: `Created tag ${d.tag} on ${d.full_name}` });
    }
    if (tool === 'github_search_prs') {
      for (const p of (d.pulls || []).slice(0, 30)) {
        out.push({
          type: 'pr',
          repo: p.repo,
          number: p.number,
          title: p.title,
          state: p.state,
          url: p.html_url,
        });
      }
    }
    if (tool === 'github_get_pr' && d.number != null) {
      out.push({
        type: 'pr',
        repo: d.full_name,
        number: d.number,
        title: d.title,
        state: d.state,
        url: d.html_url,
        ci: d.ci?.overall,
      });
      for (const i of d.jiraIssues || []) {
        out.push({ type: 'issue', key: i.key, summary: i.summary, status: i.status, browseUrl: i.browseUrl });
      }
    }
    if (tool === 'github_search_issues') {
      for (const i of (d.issues || []).slice(0, 30)) {
        out.push({ type: 'gh_issue', repo: i.repo, number: i.number, title: i.title, state: i.state, url: i.html_url });
      }
    }
    if (tool === 'github_get_issue' && d.found) {
      out.push({ type: 'gh_issue', repo: d.full_name, number: d.number, title: d.title, state: d.state, url: d.html_url });
    }
    if (tool === 'github_monthly_activity') {
      out.push({
        type: 'activity_period',
        domain: 'github',
        month: d.month,
        eventCount: d.eventCount,
        repoCount: d.repoCount,
      });
      for (const group of (d.repos || []).slice(0, 20)) {
        out.push({
          type: 'repo_activity',
          full_name: group.repo,
          url: group.url,
          events: group.activityCount,
          commits: group.commitCount,
          prs: group.prCount,
        });
      }
    }
    if (/^(Created tag |Created [\w.-]+\/[\w.-]+#\d+|Commented on )/i.test(text)) {
      out.push({ type: 'side_effect', value: text.split('\n')[0].slice(0, 160) });
    }
  },
});

module.exports = { lastGithubRefFromHistory, looksLikeGithub };
