const registry = require('../core/moduleRegistry');
const jiraUpdateTask = require('../tasks/jiraUpdate');
const jiraMyIssuesTask = require('../tasks/jiraMyIssues');
const jiraWhoamiTask = require('../tasks/jiraWhoami');
const jiraCreateTask = require('../tasks/jiraCreate');
const jiraComments = require('../tasks/jiraComments');
const jiraGetIssueTask = require('../tasks/jiraGetIssue');
const jiraMonthlyActivityTask = require('../tasks/jiraMonthlyActivity');
const jiraSearchTask = require('../tasks/jiraSearch');
const jiraLookups = require('../tasks/jiraLookups');
const jiraWrites = require('../tasks/jiraWrites');
const config = require('../config');
const { stageOrExecute } = require('../util/mutatingGate');
const { runLocalTask } = require('../util/runLocalTask');
const {
  extractIssueKeys,
  looksLikeIssueDetailFollowUp,
} = require('../util/jiraKeys');
const { looksLikeMonthlyActivity } = require('../util/monthRange');
const { parseGithubUrl } = require('../integrations/githubClient');

const READ_TOOLS = [
  'jira_my_issues',
  'jira_get_issue',
  'jira_search',
  'jira_list_comments',
  'jira_whoami',
  'jira_monthly_activity',
  'jira_get_transitions',
  'jira_find_user',
  'jira_list_projects',
];

const WRITE_TOOLS = ['jira_create', 'jira_update', 'jira_delete_comment', 'jira_link_issues', 'jira_log_work'];

const MUTATE_VERB_RE =
  /\b(create|update|transition|comment on|add comment|delete comment|move .+ to|set description|assign|reassign|unassign|link\s+([A-Z][A-Z0-9]+-\d+|it|this|that|these|them|the\s+(issues?|tickets?))|log\s+(work|time|\d+(\.\d+)?\s*[wdhm])|add label|remove label|set priority|change priority|rename)\b/i;

/** Jira writes, keyed by tool name. */
const WRITE_EXECUTORS = {
  jira_update: (a) =>
    runLocalTask('jira-update', jiraUpdateTask, jiraUpdateTask.formatResult, {
      issue: a.issue,
      status: a.status,
      comment: a.comment,
      description: a.description,
      summary: a.summary,
      assignee: a.assignee,
      priority: a.priority,
      add_labels: a.add_labels,
      remove_labels: a.remove_labels,
    }),
  jira_create: (a) =>
    runLocalTask('jira-create', jiraCreateTask, jiraCreateTask.formatResult, {
      project: a.project,
      summary: a.summary,
      type: a.type,
      description: a.description,
      assignToMe: a.assign_me,
      parent: a.parent,
      labels: a.labels,
      priority: a.priority,
      components: a.components,
    }),
  jira_delete_comment: (a) =>
    runLocalTask('jira-delete-comment', jiraComments.delete, jiraComments.formatDeleteResult, {
      issue: a.issue,
      commentId: a.comment_id,
      deleteLast: a.delete_last,
    }),
  jira_link_issues: (a) =>
    runLocalTask('jira-link-issues', jiraWrites.linkIssues, jiraWrites.formatLinkIssues, {
      from: a.from,
      to: a.to,
      type: a.type,
    }),
  jira_log_work: (a) =>
    runLocalTask('jira-log-work', jiraWrites.logWork, jiraWrites.formatLogWork, {
      issue: a.issue,
      time_spent: a.time_spent,
      started: a.started,
      comment: a.comment,
    }),
};

function handleMutating(name, args, discordCtx) {
  return stageOrExecute(name, args, discordCtx, () => WRITE_EXECUTORS[name](args), {
    domainLabel: 'Jira',
  });
}

/** Project keys from configured aliases mentioned in the text ("Platform 25" → P25). */
function aliasedProjects(text) {
  const t = String(text || '').toLowerCase();
  return Object.entries(config.JIRA_PROJECT_ALIASES || {})
    .filter(([name]) => t.includes(name.toLowerCase()))
    .map(([, key]) => key);
}

/**
 * Asks that need JQL beyond "assigned to me": sprints, other people,
 * unassigned work, a named project, or explicit JQL.
 */
function looksLikeJiraSearch(text) {
  const t = String(text || '');
  if (/\bjql\b/i.test(t)) return true;
  if (aliasedProjects(t).length || mentionsProjectKey(t)) return true;
  if (looksLikeChildSearch(t)) return true;
  return /\b(sprint|unassigned|reported by|created by|raised by|filed by|assigned to (?!me\b)[a-z]+|everyone|the team|team'?s|whole team|blockers|fix ?version)\b/i.test(
    t
  );
}

/** "project ABC", "in P25", or a configured alias key as a whole word (not an issue key). */
function mentionsProjectKey(text) {
  const t = String(text || '');
  if (/\bproject\s+[A-Z][A-Z0-9]{1,9}\b(?!-\d)/.test(t)) return true;
  if (/\b(in|for|on|from)\s+[A-Z][A-Z0-9]*\d[A-Z0-9]*\b(?!-\d)/.test(t)) return true;
  return Object.values(config.JIRA_PROJECT_ALIASES || {}).some((key) =>
    new RegExp(`\\b${key}\\b(?!-\\d)`).test(t)
  );
}

/** GitHub-flavoured asks ("issues in owner/repo", "comment on PR #3") with nothing Jira-specific. */
function looksGithubOnly(text) {
  const t = String(text || '');
  const githubish =
    Boolean(parseGithubUrl(t)) ||
    /\b(github|gh|pull requests?|PRs?)\b/i.test(t) ||
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/.test(t) ||
    /\b(in|on|for)\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(t);
  if (!githubish) return false;
  return (
    !/\b(jira|tickets?|board|sprint|epics?|stor(y|ies))\b/i.test(t) &&
    !mentionsProjectKey(t) &&
    !aliasedProjects(t).length
  );
}

/** "children of P25-100", "under P25-100", "epic P25-100" — a key used as a scope, not a lookup. */
function looksLikeChildSearch(text) {
  return /\b(children of|subtasks? (of|under)|under|in epic|epic)\s+[A-Z][A-Z0-9]+-\d+\b/i.test(String(text || ''));
}

registry.register({
  id: 'jira',

  mutatingTools: WRITE_TOOLS,

  selectTools: (intent, ctx) => {
    const names = [];
    const active =
      intent.domain === 'jira' ||
      intent.domain === 'mixed' ||
      intent.forceJiraMyIssues ||
      intent.forceJiraGetIssue ||
      intent.forceJiraMonthlyActivity ||
      intent.forceJiraSearch ||
      ctx.fallback;
    if (active) names.push(...READ_TOOLS);
    if (intent.domain === 'meta') names.push('jira_whoami');
    if ((intent.domain === 'jira' || intent.domain === 'mixed') && ctx.writes) names.push(...WRITE_TOOLS);
    return names;
  },

  intent: (text, ctx) => {
    const t = String(text || '').trim();

    // Defer to scheduler: "jira summary in 3 minutes", "send me … as a message in …"
    const { looksLikeDeferredSchedule } = require('../util/scheduleIntent');
    if (looksLikeDeferredSchedule(t)) return null;

    if (ctx.isCancellation && ctx.hasPending) {
      return null; // handled in intentRouter by pending tool domain
    }
    if (ctx.isConfirmation && ctx.hasPending) {
      return null; // handled in intentRouter by pending tool domain
    }

    const keysInText = extractIssueKeys(t);
    if (!keysInText.length && looksGithubOnly(t)) return null;
    const followUpKey = ctx.lastIssueKey || null;
    const wantsDetails =
      keysInText.length > 0 ||
      (looksLikeIssueDetailFollowUp(t) && followUpKey) ||
      (/\b(details?|description|comments?|status of|about)\b/i.test(t) && (keysInText.length || followUpKey));

    const mutate = MUTATE_VERB_RE.test(t) && /\b(ticket|issue|jira|[A-Z][A-Z0-9]+-\d+)\b/i.test(t);

    // Exact-key lookup beats list/agenda (stops fuzzy jira_my_issues on P25-3488)
    if (wantsDetails && (keysInText[0] || followUpKey) && !mutate && !looksLikeChildSearch(t)) {
      const issueKey = keysInText[0] || followUpKey;
      return {
        domain: 'jira',
        mode: 'lookup',
        budget: 'fast',
        confidence: 'high',
        reason: 'get-issue',
        forceJiraGetIssue: true,
        issueKey,
        isIssueDetail: true,
      };
    }

    // "my Jira activity for July 2026" — month report beats agenda/list handling.
    const monthly = looksLikeMonthlyActivity(t);
    if (monthly && /\b(jira|ticket|issue|sprint|board)s?\b/i.test(t)) {
      return {
        domain: 'jira',
        mode: 'activity',
        budget: 'slow',
        confidence: 'high',
        reason: 'monthly-activity',
        forceJiraMonthlyActivity: true,
        monthRef: monthly.monthRef ? monthly.monthRef.source : null,
      };
    }

    const isIssueList = /^(all|broader|broader\s+please|without\s+filter|no\s+filter|try\s+again|again|more)$/i.test(t) ||
      /\b(tickets?|issues?|stories|epics|bugs?|backlog|sprint|assigned\s+to\s+me|what('s| is| are)?\s+my\b|summar(y|ise|ize)|overview|what\s+(do\s+)?(i|these)\s+need|what\s+needs\s+to\s+be\s+done|workload|agenda)\b/i.test(t);

    let isWorkAgenda = false;
    if (isIssueList) {
      const isExplicitList = /\b(list|show|table|issue\s*keys?|jira\s+keys?)\b/i.test(t) && !/\b(don'?t|do not)\s+(talk about|mention|include|list)\b/i.test(t);
      const isExplicitKeys = /\b(give\s+me\s+(the\s+)?keys?|with\s+keys?|include\s+keys?)\b/i.test(t);
      if (!isExplicitList && !isExplicitKeys) {
        isWorkAgenda = /\b(summar(y|ise|ize)|overview|what\s+(do\s+)?(i|these)\s+(need|deal)|what\s+(\w+\s+){0,3}needs\s+to\s+be\s+done|workload|agenda|focus|priorit)\b/i.test(t) ||
          /\b(don'?t|do not)\s+(talk about|mention|include).{0,60}(individual|ids?|keys?|jira)\b/i.test(t) ||
          /\btell\s+me\s+what\s+(all\s+)?(needs|i\s+need)\b/i.test(t);
      }
    }

    const teamScope = /\b(team|everyone|unassigned|reported by|created by)\b/i.test(t);

    if (isWorkAgenda && !teamScope) {
      return { domain: 'jira', mode: 'agenda', budget: 'fast', confidence: 'high', reason: 'work-agenda', forceJiraMyIssues: true, isWorkAgenda: true };
    }
    if (mutate) {
      return { domain: 'jira', mode: 'mutate', needsConfirm: true, budget: 'fast', confidence: 'high', reason: 'mutate' };
    }
    if (isIssueList && looksLikeJiraSearch(t)) {
      return {
        domain: 'jira',
        mode: isWorkAgenda ? 'agenda' : 'lookup',
        budget: 'fast',
        confidence: 'high',
        reason: 'jira-search',
        forceJiraSearch: true,
        projects: aliasedProjects(t),
        isWorkAgenda: isWorkAgenda || undefined,
      };
    }
    if (isIssueList) {
      return { domain: 'jira', mode: 'lookup', budget: 'fast', confidence: 'high', reason: 'issue-list', forceJiraMyIssues: true, isIssueList: true };
    }
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'jira_get_issue',
        description:
          'Fetch ONE issue by exact key (e.g. P25-3488): summary, status, description, parent, subtasks, linked issues, fix versions, and GitHub PRs that mention the key. Use ONLY when you have an exact ticket key. NEVER use jira_my_issues text search for an exact key.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'Exact issue key, e.g. P25-3488' },
            include_comments: {
              anyOf: [{ type: 'boolean' }, { type: 'string' }],
              description: 'Include recent comments (default false)',
            },
            max_comments: { type: 'integer', description: 'Max comments if include_comments (default 5)' },
            include_github: {
              anyOf: [{ type: 'boolean' }, { type: 'string' }],
              description: 'Look up GitHub PRs mentioning this key (default true)',
            },
          },
          required: ['issue'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_my_issues',
        description:
          'List issues assigned to the auth user. Default resolution=unresolved. For anything not "assigned to me" (sprints, teammates, unassigned, a project) use jira_search. Do NOT pass an issue key as query — use jira_get_issue instead.',
        parameters: {
          type: 'object',
          properties: {
            max: { type: 'integer', description: 'Max issues (1-50). Default 25.' },
            status: { type: 'string', description: 'Exact status name filter, e.g. "In Progress"' },
            query: { type: 'string', description: 'Keyword text search only — not issue keys' },
            types: { type: 'string', description: 'Comma-separated issue types, only if the user named them' },
            resolution: { type: 'string', enum: ['unresolved', 'resolved', 'all'] },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_search',
        description:
          'Search ANY issues with JQL — sprints, teammates, unassigned work, projects, epics, reporters, fix versions. Examples: `project = P25 AND sprint in openSprints()`, `project = P25 AND assignee is EMPTY AND type = Bug AND resolution = Unresolved`, `reporter = currentUser() AND created >= -7d`, `parent = P25-100`, `text ~ "allocation" AND project = P25`. Always add ORDER BY (e.g. ORDER BY updated DESC).',
        parameters: {
          type: 'object',
          properties: {
            jql: { type: 'string', description: 'Full JQL query' },
            max: { type: 'integer', description: 'Max issues (1-50). Default 25.' },
            next_page_token: { type: 'string', description: 'Token from a previous result to fetch the next page' },
          },
          required: ['jql'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_monthly_activity',
        description:
          'Full Jira activity report for the auth user over ONE calendar month: issues created, transitioned, commented on, edited, or logged work against, with a dated timeline per issue. Use for "what did I do in July", "my Jira activity last month", monthly recaps. Not for current open work (use jira_my_issues).',
        parameters: {
          type: 'object',
          properties: {
            month: {
              type: 'string',
              description:
                'Month as YYYY-MM (e.g. 2026-07), "July 2026", "last month", or "this month". Defaults to the current month.',
            },
            year: { type: 'integer', description: 'Optional year if month is a bare name' },
            detail: {
              anyOf: [{ type: 'boolean' }, { type: 'string' }],
              description: 'Include changelog/comments/worklog timeline (default true)',
            },
            max_issues: { type: 'integer', description: 'Max issues to scan (default 100)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_get_transitions',
        description:
          'List the workflow transitions currently available on an issue (valid values for jira_update status).',
        parameters: {
          type: 'object',
          properties: { issue: { type: 'string', description: 'Issue key, e.g. P25-3488' } },
          required: ['issue'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_find_user',
        description:
          'Find Jira users by name or email fragment (accountId, display name). Use before assigning or writing JQL about a teammate.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Name or email fragment' },
            max: { type: 'integer', description: 'Max users (default 10)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_list_projects',
        description:
          'List Jira projects (key + name), or — with project set — the issue types you can create in that project.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Optional project name/key filter' },
            project: { type: 'string', description: 'Project key to list creatable issue types for' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_update',
        description:
          'Update a Jira issue: status (transition name or target status), comment, description (markdown, replaces existing), summary, assignee, priority, labels.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'Issue key' },
            status: { type: 'string', description: 'Transition or target status name, e.g. "In Progress"' },
            description: { type: 'string', description: 'New description (markdown) — replaces the current one' },
            comment: { type: 'string', description: 'Comment to add (markdown)' },
            summary: { type: 'string', description: 'New title' },
            assignee: { type: 'string', description: '"me", "unassigned", or a teammate name/email' },
            priority: { type: 'string', description: 'Priority name, e.g. High' },
            add_labels: { type: 'string', description: 'Comma-separated labels to add' },
            remove_labels: { type: 'string', description: 'Comma-separated labels to remove' },
          },
          required: ['issue'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_create',
        description: 'Create a new Jira issue (optionally a sub-task/child via parent).',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project key, e.g. P25' },
            summary: { type: 'string' },
            type: { type: 'string', description: 'Issue type. Default Task. Use jira_list_projects to see valid types.' },
            description: { type: 'string', description: 'Markdown description' },
            assign_me: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
            parent: { type: 'string', description: 'Parent issue key (epic or parent for sub-tasks)' },
            labels: { type: 'string', description: 'Comma-separated labels' },
            priority: { type: 'string', description: 'Priority name, e.g. High' },
            components: { type: 'string', description: 'Comma-separated component names' },
          },
          required: ['project', 'summary'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_link_issues',
        description:
          'Link two issues. Read as "<from> <type outward phrase> <to>": "P25-1 blocks P25-2" → from=P25-1, to=P25-2, type=Blocks. Common types: Relates, Blocks, Duplicate, Cloners.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Issue key the relation reads from' },
            to: { type: 'string', description: 'Issue key the relation points to' },
            type: { type: 'string', description: 'Link type name (default Relates)' },
          },
          required: ['from', 'to'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_log_work',
        description: 'Log time spent on an issue (worklog).',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'Issue key' },
            time_spent: { type: 'string', description: 'Jira duration, e.g. "1h 30m", "2h", "1d"' },
            started: { type: 'string', description: 'ISO 8601 start time (default now). Interpret user times as Europe/London.' },
            comment: { type: 'string', description: 'Optional work description' },
          },
          required: ['issue', 'time_spent'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_list_comments',
        description: 'List comments on a Jira issue.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string' },
            max: { type: 'integer' },
          },
          required: ['issue'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_delete_comment',
        description: 'Delete a comment.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string' },
            comment_id: { type: 'string' },
            delete_last: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
          },
          required: ['issue'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_whoami',
        description: 'Show which Jira account the bot is authenticated as.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],

  tasks: {
    'jira-update': { execute: jiraUpdateTask, format: jiraUpdateTask.formatResult },
    'jira-my-issues': { execute: jiraMyIssuesTask, format: jiraMyIssuesTask.formatResult },
    'jira-get-issue': { execute: jiraGetIssueTask, format: jiraGetIssueTask.formatResult },
    'jira-search': { execute: jiraSearchTask, format: jiraSearchTask.formatResult },
    'jira-monthly-activity': {
      execute: jiraMonthlyActivityTask,
      format: jiraMonthlyActivityTask.formatResult,
    },
    'jira-whoami': { execute: jiraWhoamiTask, format: jiraWhoamiTask.formatResult },
    'jira-create': { execute: jiraCreateTask, format: jiraCreateTask.formatResult },
    'jira-list-comments': { execute: jiraComments.list, format: jiraComments.formatListResult },
    'jira-delete-comment': { execute: jiraComments.delete, format: jiraComments.formatDeleteResult },
  },

  toolHandlers: {
    jira_get_issue: async (args) =>
      runLocalTask('jira-get-issue', jiraGetIssueTask, jiraGetIssueTask.formatResult, {
        issue: args.issue,
        include_comments: args.include_comments,
        max_comments: args.max_comments,
        include_github: args.include_github,
      }),
    jira_my_issues: async (args) => {
      // Guard: exact keys must use jira_get_issue
      const key = extractIssueKeys(args.query || '')[0];
      if (key && !/\s/.test(String(args.query || '').trim())) {
        return runLocalTask('jira-get-issue', jiraGetIssueTask, jiraGetIssueTask.formatResult, {
          issue: key,
          include_comments: true,
        });
      }
      return runLocalTask('jira-my-issues', jiraMyIssuesTask, jiraMyIssuesTask.formatResult, {
        max: args.max,
        status: args.status,
        query: args.query,
        types: args.types,
        resolution: args.resolution,
      });
    },
    jira_search: async (args) =>
      runLocalTask('jira-search', jiraSearchTask, jiraSearchTask.formatResult, {
        jql: args.jql,
        max: args.max,
        next_page_token: args.next_page_token,
      }),
    jira_monthly_activity: async (args) =>
      runLocalTask(
        'jira-monthly-activity',
        jiraMonthlyActivityTask,
        jiraMonthlyActivityTask.formatResult,
        {
          month: args.month,
          year: args.year,
          detail: args.detail,
          maxIssues: args.max_issues,
        }
      ),
    jira_get_transitions: async (args) =>
      runLocalTask('jira-get-transitions', jiraLookups.transitions, jiraLookups.formatTransitions, {
        issue: args.issue,
      }),
    jira_find_user: async (args) =>
      runLocalTask('jira-find-user', jiraLookups.findUser, jiraLookups.formatFindUser, {
        query: args.query,
        max: args.max,
      }),
    jira_list_projects: async (args) =>
      runLocalTask('jira-list-projects', jiraLookups.listProjects, jiraLookups.formatListProjects, {
        query: args.query,
        project: args.project,
      }),
    jira_whoami: async () =>
      runLocalTask('jira-whoami', jiraWhoamiTask, jiraWhoamiTask.formatResult),
    jira_list_comments: async (args) =>
      runLocalTask('jira-list-comments', jiraComments.list, jiraComments.formatListResult, {
        issue: args.issue,
        max: args.max,
      }),
    ...Object.fromEntries(
      WRITE_TOOLS.map((name) => [name, (args, discordCtx) => handleMutating(name, args, discordCtx)])
    ),
  },

  promptPack: (intent, opts) => {
    const confirmOn = opts.confirmOn !== false;
    const common = [
      'Jira action rules:',
      '- Exact ticket keys (P25-3488) → call jira_get_issue ONLY. Never fuzzy-search with jira_my_issues.',
      '- If the user says yes / pull details / details after you offered to fetch a ticket, call jira_get_issue immediately — do not ask again.',
      '- "My" open work → jira_my_issues. Anything broader (sprint, teammate, unassigned, a project, an epic\'s children, reporter, fix version) → jira_search with JQL.',
      '- Teammate in JQL: call jira_find_user first and use their accountId (assignee = "<accountId>").',
      '- Status change: if unsure of the name, call jira_get_transitions; jira_update also accepts the target status name.',
      '- Never invent browse URLs. Use only the URL field from tool results (from JIRA_BASE_URL).',
      '- Chat history listing a key is NOT proof it exists/does not exist — always trust THIS turn’s jira_get_issue / jira_my_issues evidence.',
      '- If you lack description/status/comments for a named ticket, invoke jira_get_issue; do not stop and claim the dataset is incomplete.',
      '- Past-period questions ("what did I do in July", "activity last month") → jira_monthly_activity, never jira_my_issues.',
    ].join('\n');

    let pack = '';
    if (intent.forceJiraMonthlyActivity) {
      pack = [
        'MONTHLY ACTIVITY mode (critical):',
        `- Call jira_monthly_activity this turn${intent.monthRef ? ` with month="${intent.monthRef}"` : ''}.`,
        '- Report only what the tool returned: issue counts, event counts, and the themes of the work.',
        '- Group related tickets into themes; quote issue keys and URLs from the tool output.',
        '- State the month explicitly so the user can confirm the period is right.',
      ].join('\n');
    } else if (intent.forceJiraGetIssue || intent.isIssueDetail) {
      pack = [
        'ISSUE DETAIL mode (critical):',
        `- Call jira_get_issue with issue=${intent.issueKey || '(key from user)'} this turn (include_comments=true if they want details).`,
        '- Do not call jira_my_issues for this.',
        '- Reply with summary, status, description, URL from the tool — no invented links.',
        '- Mention linked GitHub PRs (and their state) when the tool returned any.',
      ].join('\n');
    } else if (intent.forceJiraSearch) {
      pack = [
        'JIRA SEARCH mode (critical):',
        '- Call jira_search with JQL this turn. Do not use jira_my_issues — it only sees the user\'s own assignments.',
        intent.projects?.length ? `- Project key(s) from aliases: ${intent.projects.join(', ')}.` : '- Resolve board names to project keys via the workspace aliases.',
        '- Current sprint: sprint in openSprints(). Unresolved work: resolution = Unresolved.',
        intent.isWorkAgenda
          ? '- Answer as grouped themes, not a ticket inventory.'
          : '- List key, summary, status, assignee, and the URL from the tool.',
      ].join('\n');
    } else if (intent.mode === 'agenda' || intent.isWorkAgenda) {
      pack = [
        'WORK AGENDA mode (critical):',
        '- Call jira_my_issues for fresh data, then answer as grouped "you need to…" bullets.',
        '- Group by theme; merge overlapping tickets. No markdown tables.',
        '- Do NOT list issue keys/IDs unless the user asked for keys/table/list.',
        '- Skip Dropped/cancelled unless asked. Call out the single highest-priority focus in one line.',
      ].join('\n');
    } else if (intent.mode === 'mutate' || intent.mode === 'confirm') {
      const writeNames = WRITE_TOOLS.join(' / ');
      pack = !confirmOn
        ? `- ${writeNames} execute immediately.\n- After a write, include the browse URL from the tool.`
        : `- ${writeNames} only PROPOSE; they never write themselves.\n- Show the plan and wait for the user’s next message — do not call confirm_pending in the same turn.\n- Never claim created/updated/linked/logged until confirm_pending returns success.`;
    } else {
      pack = [
        'Jira lookup mode:',
        '- Ticket list / my issues → jira_my_issues (omit query/types for all open work).',
        '- Broader lists → jira_search. Named key → jira_get_issue.',
      ].join('\n');
    }
    return `${common}\n\n${pack}`;
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    const jiraDomain = intent.domain === 'jira' || intent.domain === 'mixed';
    if (intent.forceJiraMonthlyActivity || (intent.mode === 'activity' && jiraDomain)) {
      pushTool(
        'jira_monthly_activity',
        `Month activity report${intent.monthRef ? ` for ${intent.monthRef}` : ''}`
      );
      return;
    }
    if (intent.forceJiraGetIssue || intent.isIssueDetail) {
      pushTool('jira_get_issue', `Exact fetch for ${intent.issueKey || 'named issue key'}`);
      return;
    }
    if (intent.forceJiraSearch) {
      pushTool('jira_search', 'JQL search beyond the user\'s own assignments');
      return;
    }
    if (intent.forceJiraMyIssues || intent.mode === 'agenda' || intent.mode === 'lookup') {
      if (intent.domain === 'jira' || intent.domain === 'mixed' || intent.isIssueList || intent.isWorkAgenda) {
        pushTool('jira_my_issues', intent.isWorkAgenda ? 'Fresh issues for work-agenda synthesis' : 'Fresh issue list for this turn');
      }
    }
    if (intent.mode === 'mutate' && jiraDomain) {
      pushGuidance('use_jira_write_tools', `Call ${WRITE_TOOLS.join(' / ')} as needed (real tool names only)`);
    }
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (tool === 'jira_get_issue') {
      const d = envelope.data || {};
      if (d.found === false || envelope.ok === false) {
        out.push({ type: 'issue_missing', key: d.issueKey || '?', value: d.error || 'not found' });
      } else if (d.issueKey || d.found) {
        out.push({
          type: 'issue_detail',
          key: d.issueKey,
          summary: d.summary,
          status: d.status,
          browseUrl: d.browseUrl,
        });
        for (const p of d.pulls || []) {
          out.push({ type: 'pr', repo: p.repo, number: p.number, title: p.title, state: p.state, url: p.html_url });
        }
      }
    }
    if (tool === 'jira_search' && envelope.ok !== false) {
      const d = envelope.data || {};
      out.push({ type: 'issue_count', value: d.count ?? 0 });
      for (const issue of (d.issues || []).slice(0, 30)) {
        out.push({ type: 'issue', key: issue.key, summary: issue.summary, status: issue.status, browseUrl: issue.browseUrl });
      }
    }
    if (tool === 'jira_monthly_activity') {
      const d = envelope.data || {};
      out.push({
        type: 'activity_period',
        domain: 'jira',
        month: d.month,
        issueCount: d.issueCount,
        eventCount: d.eventCount,
      });
      for (const issue of (d.issues || []).slice(0, 30)) {
        out.push({
          type: 'issue',
          key: issue.key,
          summary: issue.summary,
          status: issue.status,
          browseUrl: issue.browseUrl,
        });
      }
    }
    if (tool === 'jira_my_issues') {
      if (envelope.data && typeof envelope.data.count === 'number') {
        out.push({ type: 'issue_count', value: envelope.data.count });
      } else {
        const m = String(text).match(/Assigned to you[^:]*:\s*(\d+)/i);
        if (m) out.push({ type: 'issue_count', value: Number(m[1]) });
        if (/No (unresolved |resolved )?issues/i.test(text)) out.push({ type: 'issue_count', value: 0 });
      }
      if (Array.isArray(envelope.data?.issues)) {
        for (const issue of envelope.data.issues.slice(0, 30)) {
          out.push({ type: 'issue', key: issue.key, summary: issue.summary, status: issue.status, browseUrl: issue.browseUrl });
        }
      }
    }
    if (/Created |Updated |Deleted |Cancelled |Linked |Logged /i.test(text)) {
      out.push({ type: 'side_effect', value: text.split('\n')[0].slice(0, 160) });
    }
  }
});

module.exports = { looksLikeJiraSearch, aliasedProjects };
