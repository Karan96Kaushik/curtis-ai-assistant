const registry = require('../core/moduleRegistry');
const jiraUpdateTask = require('../tasks/jiraUpdate');
const jiraMyIssuesTask = require('../tasks/jiraMyIssues');
const jiraWhoamiTask = require('../tasks/jiraWhoami');
const jiraCreateTask = require('../tasks/jiraCreate');
const jiraComments = require('../tasks/jiraComments');
const jiraGetIssueTask = require('../tasks/jiraGetIssue');
const jiraMonthlyActivityTask = require('../tasks/jiraMonthlyActivity');
const pendingActions = require('../ai/pendingActions');
const config = require('../config');
const { stageOrExecute, runConfirmedPending } = require('../util/mutatingGate');
const { envelopeFromRaw } = require('../util/taskResult');
const { startTimer } = require('../util/timing');
const {
  extractIssueKeys,
  looksLikeIssueDetailFollowUp,
} = require('../util/jiraKeys');
const { looksLikeMonthlyActivity } = require('../util/monthRange');

/** Run a jira task locally — avoids taskRunner circular dependency. */
async function runLocalTask(name, execute, format, payload = {}) {
  const timer = startTimer(`task.${name}`);
  try {
    const raw = await execute(payload);
    const text = typeof format === 'function'
      ? format(raw)
      : typeof raw === 'object'
        ? JSON.stringify(raw, null, 2)
        : String(raw);
    const envelope = envelopeFromRaw(name, raw);
    timer.end();
    return { text, envelope, raw };
  } catch (err) {
    timer.end('FAILED');
    throw err;
  }
}

registry.register({
  id: 'jira',

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
    const followUpKey = ctx.lastIssueKey || null;
    const wantsDetails =
      keysInText.length > 0 ||
      (looksLikeIssueDetailFollowUp(t) && followUpKey) ||
      (/\b(details?|description|comments?|status of|about)\b/i.test(t) && (keysInText.length || followUpKey));

    // Exact-key lookup beats list/agenda (stops fuzzy jira_my_issues on P25-3488)
    if (wantsDetails && (keysInText[0] || followUpKey) && !/\b(create|update|transition|comment on|delete comment)\b/i.test(t)) {
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
      /\b(tickets?|issues?|stories|epics|backlog|assigned\s+to\s+me|what('s| is| are)?\s+my\b|summar(y|ise|ize)|overview|what\s+(do\s+)?(i|these)\s+need|what\s+needs\s+to\s+be\s+done|workload|agenda)\b/i.test(t);

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

    const mutate = /\b(create|update|transition|comment on|add comment|delete comment|move .+ to|set description|assign)\b/i.test(t) &&
      /\b(ticket|issue|jira|[A-Z][A-Z0-9]+-\d+)\b/i.test(t);

    if (isWorkAgenda) {
      return { domain: 'jira', mode: 'agenda', budget: 'fast', confidence: 'high', reason: 'work-agenda', forceJiraMyIssues: true, isWorkAgenda: true };
    }
    if (mutate) {
      return { domain: 'jira', mode: 'mutate', needsConfirm: true, budget: 'fast', confidence: 'high', reason: 'mutate' };
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
          'Fetch ONE issue by exact key (e.g. P25-3488) via GET /issue/{key}. Use ONLY when you have an exact ticket key. NEVER use jira_my_issues text search for an exact key.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'Exact issue key, e.g. P25-3488' },
            include_comments: {
              anyOf: [{ type: 'boolean' }, { type: 'string' }],
              description: 'Include recent comments (default false)',
            },
            max_comments: { type: 'integer', description: 'Max comments if include_comments (default 5)' },
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
          'List issues assigned to the auth user. Default resolution=unresolved. Do NOT pass an issue key as query — use jira_get_issue instead.',
        parameters: {
          type: 'object',
          properties: {
            max: { type: 'integer', description: 'Max issues (1-50). Default 25.' },
            status: { type: 'string' },
            query: { type: 'string', description: 'Keyword text search only — not issue keys' },
            types: { type: 'string' },
            resolution: { type: 'string', enum: ['unresolved', 'resolved', 'all'] },
          },
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
        name: 'jira_update',
        description: 'Update a Jira issue.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string' },
            status: { type: 'string' },
            description: { type: 'string' },
            comment: { type: 'string' },
          },
          required: ['issue'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'jira_create',
        description: 'Create a new Jira issue.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            summary: { type: 'string' },
            type: { type: 'string', description: 'Default Task.' },
            description: { type: 'string' },
            assign_me: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
          },
          required: ['project', 'summary'],
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
    {
      type: 'function',
      function: {
        name: 'confirm_pending',
        description:
          'Execute the pending mutating action (Jira, browser, Teams, etc.). Only after explicit user confirmation.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_pending',
        description: 'Cancel the pending mutating action.',
        parameters: { type: 'object', properties: {} },
      },
    }
  ],

  tasks: {
    'jira-update': { execute: jiraUpdateTask, format: jiraUpdateTask.formatResult },
    'jira-my-issues': { execute: jiraMyIssuesTask, format: jiraMyIssuesTask.formatResult },
    'jira-get-issue': { execute: jiraGetIssueTask, format: jiraGetIssueTask.formatResult },
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
    jira_whoami: async () =>
      runLocalTask('jira-whoami', jiraWhoamiTask, jiraWhoamiTask.formatResult),
    jira_list_comments: async (args) =>
      runLocalTask('jira-list-comments', jiraComments.list, jiraComments.formatListResult, {
        issue: args.issue,
        max: args.max,
      }),
    jira_update: async (args, discordCtx) => handleMutating('jira_update', args, discordCtx),
    jira_create: async (args, discordCtx) => handleMutating('jira_create', args, discordCtx),
    jira_delete_comment: async (args, discordCtx) => handleMutating('jira_delete_comment', args, discordCtx),
    confirm_pending: async (args, discordCtx) => {
      const confirmOn = config.REQUIRE_CONFIRMATION !== false;
      if (!confirmOn) {
        return { text: 'Confirmation is disabled. Mutating tools already execute immediately.', envelope: { ok: true, source: 'policy', confidence: 'high', data: null } };
      }
      const pending = pendingActions.get(discordCtx.channelId, discordCtx.userId);
      if (!pending) return { text: 'No pending action to confirm.', envelope: { ok: false, source: 'policy', confidence: 'high', data: null, error: 'no_pending' } };
      if (pending.turnId && discordCtx._turnId && pending.turnId === discordCtx._turnId) {
        return { text: 'BLOCKED: cannot confirm in the same turn that proposed the action.', envelope: { ok: false, source: 'policy', confidence: 'high', data: null, error: 'same_turn_confirm' } };
      }
      const taken = pendingActions.take(discordCtx.channelId, discordCtx.userId);
      try {
        const result = await runConfirmedPending(taken, discordCtx, {
          jiraExecutors: {
            jira_update: (a) => executeMutatingDirectly('jira_update', a),
            jira_create: (a) => executeMutatingDirectly('jira_create', a),
            jira_delete_comment: (a) => executeMutatingDirectly('jira_delete_comment', a),
          },
        });
        // Soft-fail (e.g. extension offline): put the pending action back so the user can retry
        if (result?.envelope && result.envelope.ok === false) {
          pendingActions.set(discordCtx.channelId, discordCtx.userId, {
            tool: taken.tool,
            args: taken.args,
            summary: taken.summary,
            turnId: null,
          });
        }
        return result;
      } catch (err) {
        pendingActions.set(discordCtx.channelId, discordCtx.userId, { tool: taken.tool, args: taken.args, summary: taken.summary, turnId: null });
        throw err;
      }
    },
    cancel_pending: async (args, discordCtx) => {
      const confirmOn = config.REQUIRE_CONFIRMATION !== false;
      if (!confirmOn) return { text: 'Confirmation is disabled.', envelope: { ok: true, source: 'policy', confidence: 'high', data: null } };
      const pending = pendingActions.get(discordCtx.channelId, discordCtx.userId);
      if (!pending) return { text: 'No pending action to cancel.', envelope: { ok: false, source: 'policy', confidence: 'high', data: null, error: 'no_pending' } };
      const { rejectIfReleasePending } = require('./release');
      if (pending.tool === 'wf_release_execute_pending') {
        pendingActions.clear(discordCtx.channelId, discordCtx.userId);
        const releaseReject = await rejectIfReleasePending(pending, discordCtx);
        return {
          text: releaseReject?.text || `Skipped pending release action:\n${pending.summary}`,
          envelope: releaseReject?.envelope || {
            ok: true,
            source: 'policy',
            confidence: 'high',
            data: { cancelled: true, advanced: true },
          },
        };
      }
      pendingActions.clear(discordCtx.channelId, discordCtx.userId);
      return { text: `Cancelled pending action:\n${pending.summary}`, envelope: { ok: true, source: 'policy', confidence: 'high', data: { cancelled: true } } };
    }
  },

  promptPack: (intent, opts) => {
    const confirmOn = opts.confirmOn !== false;
    const common = [
      'Jira action rules:',
      '- Exact ticket keys (P25-3488) → call jira_get_issue ONLY. Never fuzzy-search with jira_my_issues.',
      '- If the user says yes / pull details / details after you offered to fetch a ticket, call jira_get_issue immediately — do not ask again.',
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
      pack = !confirmOn
        ? '- jira_create / jira_update / jira_delete_comment execute immediately.\n- After create/update, include the browse URL from the tool.'
        : '- jira_create / jira_update / jira_delete_comment only PROPOSE; they never write themselves.\n- Show the plan and wait for the user’s next message — do not call confirm_pending in the same turn.\n- Never claim created/updated/deleted until confirm_pending returns success.';
    } else {
      pack = [
        'Jira lookup mode:',
        '- Ticket list / my issues → jira_my_issues (omit query/types for all open work).',
        '- Named key → jira_get_issue.',
      ].join('\n');
    }
    return `${common}\n\n${pack}`;
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.mode === 'confirm') {
      if (opts.hasPending) {
        pushTool('confirm_pending', 'If user confirmed, execute the staged pending action');
        pushTool('cancel_pending', 'If user declined, cancel the staged action');
      }
    }
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
    if (intent.forceJiraMyIssues || intent.mode === 'agenda' || intent.mode === 'lookup') {
      if (intent.domain === 'jira' || intent.domain === 'mixed' || intent.isIssueList || intent.isWorkAgenda) {
        pushTool('jira_my_issues', intent.isWorkAgenda ? 'Fresh issues for work-agenda synthesis' : 'Fresh issue list for this turn');
      }
    }
    if (intent.mode === 'mutate' && (intent.domain === 'jira' || intent.domain === 'mixed')) {
      pushGuidance('use_jira_write_tools', 'Call jira_create / jira_update / jira_delete_comment as needed (real tool names only)');
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
    if (/Created |Updated |Deleted |Cancelled /i.test(text)) {
      out.push({ type: 'side_effect', value: text.split('\n')[0].slice(0, 160) });
    }
  }
});

async function handleMutating(name, args, discordCtx) {
  return stageOrExecute(
    name,
    args,
    discordCtx,
    () => executeMutatingDirectly(name, args),
    { domainLabel: 'Jira' }
  );
}

async function executeMutatingDirectly(name, args) {
  if (name === 'jira_update') {
    return runLocalTask('jira-update', jiraUpdateTask, jiraUpdateTask.formatResult, {
      issue: args.issue,
      status: args.status,
      comment: args.comment,
      description: args.description,
    });
  }
  if (name === 'jira_create') {
    return runLocalTask('jira-create', jiraCreateTask, jiraCreateTask.formatResult, {
      project: args.project,
      summary: args.summary,
      type: args.type,
      description: args.description,
      assignToMe: args.assign_me,
    });
  }
  if (name === 'jira_delete_comment') {
    return runLocalTask('jira-delete-comment', jiraComments.delete, jiraComments.formatDeleteResult, {
      issue: args.issue,
      commentId: args.comment_id,
      deleteLast: args.delete_last,
    });
  }
  throw new Error(`Not a mutating tool: ${name}`);
}
