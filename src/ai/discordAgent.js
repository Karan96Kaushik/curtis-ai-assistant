const { chat, isConfigured, DEFAULT_MODEL } = require('../integrations/groqClient');
const conversationStore = require('./conversationStore');
const orgMemory = require('./orgMemory');
const pendingActions = require('./pendingActions');
const replyGuard = require('./replyGuard');
const intentRouter = require('./intentRouter');
const registry = require('../core/moduleRegistry');
const { buildPlan, formatPlanForPrompt, isCapabilityAsk } = require('./planner');
const { EvidenceLedger } = require('./evidenceLedger');
const { packsForIntent } = require('./promptPacks');
const { toolsForIntent, buildAllTools } = require('./toolRegistry');
const { synthesize } = require('./synthesizer');
const { executeTaskDetailed } = require('../discord/taskRunner');
const { startTimer } = require('../util/timing');
const { nowForPrompt } = require('../util/time');
const { lastIssueKeyFromHistory, extractIssueKeys } = require('../util/jiraKeys');
const config = require('../config');

const MAX_TOOL_ROUNDS = 8;

/** Tools that create/update/delete Jira data — hard-gated when REQUIRE_CONFIRMATION is on. */
const MUTATING_TOOLS = new Set(['jira_create', 'jira_update', 'jira_delete_comment']);

const CONFIRM_RE =
  /^(y|yes|yeah|yep|yup|ok|okay|k|confirm|confirmed|go|go\s*ahead|do\s*it|proceed|approve|approved|lgtm|ship\s*it|sure|sounds\s*good|yes\s*please)([\s.!?]|$)/i;

const CANCEL_RE =
  /^(n|no|nope|nah|cancel|cancelled|canceled|never\s*mind|nevermind|stop|abort|don'?t)([\s.!?]|$)/i;

const SKIP_PENDING_RE =
  /\bskip\b(.{0,40}\b(tag|ticket|qa|deploy|step|this|creation)\b)?/i;

function requireConfirmation() {
  return config.REQUIRE_CONFIRMATION !== false;
}

function isUserConfirmation(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return false;
  return CONFIRM_RE.test(t);
}

function isUserCancellation(text, pending = null) {
  const t = String(text || '').trim();
  if (!t || t.length > 120) return false;
  if (CANCEL_RE.test(t)) return true;
  // Bare "skip" or "skip tag …" while a release action is staged
  if (pending?.tool === 'wf_release_execute_pending' && /^skip\b/i.test(t)) {
    return true;
  }
  return false;
}

function lastWorkflowIdFromHistory(history) {
  const { extractWorkflowId } = require('../modules/release');
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const id = extractWorkflowId(history[i]?.content);
    if (id) return id;
  }
  return null;
}

const looksLikeIssueListRequest = intentRouter.looksLikeIssueListRequest;
const looksLikeWorkSummaryRequest = intentRouter.looksLikeWorkSummaryRequest;

/**
 * Strip empty filters and wrong inherited types when user asks for all/my tickets.
 * @param {object} args
 * @param {string} userText
 */
function sanitizeMyIssuesArgs(args, userText) {
  const out = { ...args };
  const text = String(userText || '');

  if (typeof out.query === 'string' && !out.query.trim()) delete out.query;
  if (typeof out.types === 'string' && !out.types.trim()) delete out.types;

  const asksAllOrMy =
    /\b(all|my)\s+(active\s+)?(tickets?|issues?)\b/i.test(text) ||
    /^(active\s+)?(tickets?|issues?)$/i.test(text.trim()) ||
    /^all(\s+tickets?)?$/i.test(text.trim()) ||
    /^(all|broader|without\s+filter|no\s+filter|try\s+again|again|more)$/i.test(text.trim()) ||
    /\blist\s+(all\s+)?(my\s+)?(tickets?|issues?)\b/i.test(text);

  const namesTypes = /\b(stor(y|ies)|epics?|tasks?|bugs?|sub-?tasks?)\b/i.test(text);
  const namesTopic =
    /\b(related to|about|for|concerning)\b/i.test(text) ||
    /\b(allocation|scheduling|charging|deploy|optimisation|optimization)\b/i.test(text);

  const asksResolved =
    /\b(resolved|closed|done|completed|finished)\b/i.test(text) &&
    !/\bunresolved\b/i.test(text) &&
    !/\b(open|active|in\s+progress)\b/i.test(text);
  const asksAllResolution =
    /\b(including\s+resolved|resolved\s+and\s+unresolved|open\s+and\s+closed|all\s+resolutions?)\b/i.test(
      text
    );

  if (asksAllResolution) {
    out.resolution = 'all';
  } else if (asksResolved) {
    out.resolution = 'resolved';
  }

  if (asksAllOrMy && !namesTypes) {
    delete out.types;
  }
  if (asksAllOrMy && !namesTopic) {
    delete out.query;
  }
  if (namesTopic && !namesTypes) {
    delete out.types;
  }

  return out;
}

/** Full tool catalog (tests / introspection). Prefer toolsForIntent at runtime. */
const TOOLS = buildAllTools({ confirmOn: true });

function coerceBoolean(value, defaultValue = undefined) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(v)) return true;
    if (['false', '0', 'no', 'n'].includes(v)) return false;
  }
  return Boolean(value);
}

function coerceArgs(name, args) {
  const out = { ...args };

  if (name === 'jira_create') {
    if (out.project && typeof out.project === 'string') {
      out.project = out.project.trim().toUpperCase();
    }
    out.assign_me = coerceBoolean(out.assign_me, true);
  }

  if (name === 'jira_delete_comment') {
    out.delete_last = coerceBoolean(out.delete_last, false);
    if (out.comment_id != null) out.comment_id = String(out.comment_id);
  }

  if (name === 'jira_my_issues') {
    if (out.max != null) out.max = Number(out.max);
    if (out.query == null && out.text != null) out.query = out.text;
    if (typeof out.query === 'string' && !out.query.trim()) delete out.query;
    if (typeof out.types === 'string' && !out.types.trim()) delete out.types;
    if (typeof out.type === 'string' && !out.type.trim()) delete out.type;
  }
  if (name === 'jira_get_issue') {
    if (out.issue != null) out.issue = String(out.issue).trim().toUpperCase();
    out.include_comments = coerceBoolean(out.include_comments, false);
    if (out.max_comments != null) out.max_comments = Number(out.max_comments);
  }
  if (name === 'jira_list_comments' && out.max != null) {
    out.max = Number(out.max);
  }
  if (name === 'jira_monthly_activity' || name === 'github_monthly_activity') {
    if (typeof out.month === 'string') {
      out.month = out.month.trim();
      if (!out.month) delete out.month;
    }
    if (out.year != null) out.year = Number(out.year);
    if (out.max_issues != null) out.max_issues = Number(out.max_issues);
    if (name === 'jira_monthly_activity') out.detail = coerceBoolean(out.detail, true);
    if (name === 'github_monthly_activity') {
      for (const key of ['logins', 'aliases']) {
        if (Array.isArray(out[key])) out[key] = out[key].join(',');
        if (typeof out[key] === 'string' && !out[key].trim()) delete out[key];
      }
    }
  }
  if (name === 'memory_read' && out.max_chars != null) {
    out.max_chars = Number(out.max_chars);
  }

  if (name?.startsWith('github_')) {
    if (out.max != null) out.max = Number(out.max);
    if (out.number != null) out.number = Number(out.number);
    if (typeof out.repo === 'string') out.repo = out.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
    if (typeof out.tag === 'string') out.tag = out.tag.replace(/^refs\/tags\//, '').trim();
  }

  return out;
}

/**
 * @param {object} discordCtx
 * @param {{ intent: object, plan: object }} turn
 */
function buildSystemPrompt(discordCtx, turn) {
  const when = nowForPrompt();
  const memory = orgMemory.forPrompt();
  const confirmOn = requireConfirmation();
  const pending = pendingActions.get(discordCtx.channelId, discordCtx.userId);
  const modePack = packsForIntent(turn.intent, { confirmOn });

  let confirmationBlock;
  if (!confirmOn) {
    confirmationBlock = [
      'Confirmation: DISABLED (config.REQUIRE_CONFIRMATION=false).',
      '- Mutating tools execute immediately.',
    ].join('\n');
  } else {
    const pendingBlock = pending
      ? [
          'Pending action awaiting user confirmation:',
          pending.summary,
          `Tool: ${pending.tool}`,
          'If this user message is an explicit yes/confirm → call confirm_pending (applies to Jira, GitHub, browser, Teams, or release).',
          'If they decline → call cancel_pending.',
          'If they want changes → call the propose tool again with revised args (replaces pending), then ask again.',
        ].join('\n')
      : 'No pending mutating action.';

    confirmationBlock = [
      'Confirmation: REQUIRED for gated writes (hard gate).',
      '- Jira create/update/delete, GitHub create-tag, browser click/type, and WF release mutating steps only PROPOSE until confirm_pending succeeds.',
      '- teams_open, browser_open_tab, and browser_navigate execute immediately (focus existing when possible).',
      '- Never claim a gated write succeeded until confirm_pending returns success.',
      '- Never invent "Jira" wording for a Teams/browser/GitHub/release pending action.',
      '',
      pendingBlock,
    ].join('\n');
  }

  return [
    modePack,
    '',
    'Multilayer turn protocol:',
    '- Only call tools that appear in the API tools list for this turn. Never invent tool names.',
    '- Plan lines marked [TOOL] use that exact function name. [GUIDANCE] is instruction only — not callable.',
    '- NEVER call synthesize, finalize, answer, or answer_in_plain_text — those are not tools.',
    '- When no tool is needed (e.g. "what can you do?"), reply with plain assistant text immediately.',
    '- Optional: use think for a private scratchpad on complex asks.',
    '- After tools (or with no tools), stop tool-calling; a separate system pass synthesizes the final reply.',
    '- Prefer required fields over guessing (especially travel dates).',
    '',
    'Structured plan for this turn:',
    formatPlanForPrompt(turn.plan),
    '',
    `Intent: domain=${turn.intent.domain} mode=${turn.intent.mode} budget=${turn.intent.budget} confidence=${turn.intent.confidence} (${turn.intent.reason})`,
    '',
    confirmationBlock,
    '',
    'Behavioral rules:',
    confirmOn
      ? '- After a successful confirm_pending create/update, ALWAYS include the browse URL from the tool result.'
      : '- After create/update, ALWAYS include the browse URL from the tool result.',
    '- On create: default assign_me=true unless the user says not to assign.',
    '- Put Branch, GH link, Dev Env into the issue description (markdown) on create when provided.',
    '- Resolve board/project names via Org memory (Platform 25 → P25). Uppercase project keys.',
    '- When remembering domains, store a short lesson under Domains/workstreams plus key tickets.',
    '- Keep Discord replies concise (under ~1800 characters).',
    '',
    'Org memory (durable, org-wide):',
    memory,
    '',
    'Discord session context:',
    `- UK / BST time: ${when}`,
    `- Discord user: ${discordCtx.displayName || discordCtx.username} (id=${discordCtx.userId})`,
    `- Username: ${discordCtx.username}`,
    `- Channel id: ${discordCtx.channelId}`,
    `- Guild id: ${discordCtx.guildId || '(DM)'}`,
    `- Channel type: ${discordCtx.channelType || 'unknown'}`,
    '',
    `Model: ${DEFAULT_MODEL} via Groq.`,
  ].join('\n');
}

function asToolPayload(text, envelope) {
  return {
    text: String(text),
    envelope: envelope || {
      ok: !/^Error:|^BLOCKED:/i.test(String(text)),
      source: 'agent',
      confidence: 'medium',
      data: null,
    },
  };
}

async function executeMutatingTool(name, args) {
  if (name === 'jira_update') {
    return executeTaskDetailed('jira-update', {
      issue: args.issue,
      status: args.status,
      comment: args.comment,
      description: args.description,
    });
  }
  if (name === 'jira_create') {
    return executeTaskDetailed('jira-create', {
      project: args.project,
      summary: args.summary,
      type: args.type,
      description: args.description,
      assignToMe: args.assign_me,
    });
  }
  if (name === 'jira_delete_comment') {
    return executeTaskDetailed('jira-delete-comment', {
      issue: args.issue,
      commentId: args.comment_id,
      deleteLast: args.delete_last,
    });
  }
  throw new Error(`Not a mutating tool: ${name}`);
}

function stageMutatingTool(name, args, discordCtx) {
  const summary = pendingActions.buildSummary(name, args);
  pendingActions.set(discordCtx.channelId, discordCtx.userId, {
    tool: name,
    args,
    summary,
    turnId: discordCtx._turnId || null,
  });
  const text = [
    'PENDING CONFIRMATION — nothing was changed in Jira yet (hard gate).',
    summary,
    '',
    'Show this plan to the user and ask them to confirm or cancel in their next reply.',
    'Do NOT call confirm_pending in this turn — wait for their next message.',
    'When they confirm (yes/confirm), call confirm_pending. When they decline, call cancel_pending.',
    'If they want edits, call this propose tool again with updated arguments.',
  ].join('\n');
  return asToolPayload(text, {
    ok: true,
    source: 'pending',
    confidence: 'high',
    data: { staged: true, tool: name, args },
  });
}

async function runTool(name, rawArgs, discordCtx) {
  const timer = startTimer(`agent.tool.${name}`);
  try {
    const handler = registry.getToolHandler(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const normalized = coerceArgs(name, rawArgs || {});
    const payload = await handler(normalized, discordCtx);
    
    // Ensure payload conforms to { text, envelope }
    if (payload.text !== undefined && payload.envelope !== undefined) {
      timer.end();
      return payload;
    }

    // Wrap plain string results in a basic envelope (should be rare now)
    timer.end();
    return asToolPayload(String(payload.text || payload), {
      ok: !/^Error:|^BLOCKED:/i.test(String(payload.text || payload)),
      source: name,
      confidence: 'medium',
      data: payload.data || null,
      error: /^Error:/i.test(String(payload.text || payload)) ? 'unknown' : undefined
    });

  } catch (err) {
    timer.end('FAILED');
    throw err;
  }
}

/**
 * One repair round when claim/grounding gate fails — no write tools.
 */
async function repairUngroundedReply(messages, draft, toolResults, evidence) {
  const repairTimer = startTimer('agent.claimGate.repair');
  const outcomes = evidence
    ? evidence.summaryForPrompt()
    : replyGuard.summarizeToolOutcomes(toolResults);
  const repairMessages = [
    ...messages,
    { role: 'assistant', content: draft },
    {
      role: 'system',
      content: [
        'CLAIM/GROUNDING GATE: Your draft is not supported by this turn’s evidence.',
        `Evidence / tool outcomes:\n${outcomes}`,
        'Rewrite the user-facing reply using ONLY that evidence. Disclose mock/low-confidence/errors. No tools.',
      ].join('\n'),
    },
  ];

  try {
    const completion = await chat({
      messages: repairMessages,
      toolChoice: 'none',
    });
    const repaired = (completion.choices?.[0]?.message?.content || '').trim();
    repairTimer.end(repaired ? 'ok' : 'empty');
    if (!repaired) return replyGuard.fallbackFromTools(toolResults, evidence);
    const check = replyGuard.checkReplyGrounding(repaired, toolResults, evidence);
    if (!check.ok) {
      return replyGuard.fallbackFromTools(toolResults, evidence);
    }
    return repaired;
  } catch (err) {
    repairTimer.end('FAILED');
    console.error('[claim-gate] repair failed:', err.message || err);
    return replyGuard.fallbackFromTools(toolResults, evidence);
  }
}

function shouldSynthesize(intent, toolResults) {
  if (!toolResults.length) return false;
  if (intent.mode === 'agenda' || intent.mode === 'research' || intent.mode === 'compare') return true;
  if (intent.domain === 'web' || intent.domain === 'travel' || intent.domain === 'jira' || intent.domain === 'github' || intent.domain === 'browser' || intent.domain === 'teams' || intent.domain === 'release') return true;
  if (intent.isWorkAgenda || intent.isIssueList || intent.isIssueDetail) return true;
  return toolResults.some((t) =>
    ['web_search', 'web_fetch_page', 'web_check_prices', 'jira_my_issues', 'jira_get_issue', 'jira_monthly_activity', 'memory_read', 'browser_read_page', 'browser_list_tabs', 'teams_list_chats', 'teams_read_messages', 'github_search_repos', 'github_list_repos', 'github_list_tags', 'github_search_prs', 'github_get_pr', 'github_monthly_activity', 'wf_release_start', 'wf_release_draft', 'wf_release_revise_draft', 'wf_release_approve_draft', 'wf_release_status', 'wf_release_advance', 'wf_release_skip', 'wf_release_revise_pending', 'wf_release_answer', 'wf_release_edit', 'wf_release_approve_review', 'wf_release_execute_pending'].includes(t.name)
  );
}

/**
 * Handle a natural-language Discord message with multilayer cognition + tools.
 * @param {{ text: string, discord: object }} input
 * @returns {Promise<string>}
 */
async function handleUserMessage({ text, discord }) {
  if (!isConfigured()) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const total = startTimer('agent.handleUserMessage');
  const { channelId, userId } = discord;
  const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const turnCtx = {
    ...discord,
    _turnId: turnId,
    _userText: text,
  };

  /** @type {{ name: string, result: string }[]} */
  const toolResults = [];
  const evidence = new EvidenceLedger();

  try {
    const prep = startTimer('agent.prep');
    conversationStore.ensureSession(channelId, userId, discord);
    conversationStore.appendMessage(channelId, userId, 'user', text, discord);

    const pending = pendingActions.get(channelId, userId);
    const hasPending = Boolean(pending);

    if (requireConfirmation() && isUserCancellation(text, pending)) {
      if (pending) {
        const { rejectIfReleasePending } = require('../modules/release');
        if (pending.tool === 'wf_release_execute_pending') {
          // Drop the cancelled stage first; reject may stage the *next* release step.
          pendingActions.clear(channelId, userId);
          const releaseReject = await rejectIfReleasePending(pending, turnCtx);
          const reply =
            releaseReject?.text ||
            `Skipped pending release action:\n${pending.summary}`;
          conversationStore.appendMessage(channelId, userId, 'assistant', reply, discord);
          prep.end('auto-cancel-release');
          total.end('auto-cancel-release');
          return reply;
        }
        pendingActions.clear(channelId, userId);
        const reply = `Cancelled pending action:\n${pending.summary}`;
        conversationStore.appendMessage(channelId, userId, 'assistant', reply, discord);
        prep.end('auto-cancel');
        total.end('auto-cancel');
        return reply;
      }
    }

    // Fast-path: short yes/confirm executes the staged action without another LLM ask-loop
    if (requireConfirmation() && isUserConfirmation(text) && pending) {
      const confirmHandler = registry.getToolHandler('confirm_pending');
      if (confirmHandler) {
        const result = await confirmHandler({}, turnCtx);
        const reply =
          result?.text ||
          (result?.envelope?.ok === false
            ? `Could not confirm: ${result.envelope.error || 'unknown error'}`
            : 'Confirmed.');
        conversationStore.appendMessage(channelId, userId, 'assistant', reply, discord);
        evidence.ingest('confirm_pending', { text: reply, envelope: result?.envelope });
        prep.end(`auto-confirm tool=${pending.tool}`);
        total.end('auto-confirm');
        console.log(`[agent] auto-confirm pending=${pending.tool} ok=${result?.envelope?.ok !== false}`);
        return reply;
      }
    }

    // L1 — Intent (pass last mentioned issue key for "yes / details" follow-ups)
    const historyForIntent = conversationStore.getHistory(channelId, userId);
    const lastIssueKey =
      extractIssueKeys(text)[0] || lastIssueKeyFromHistory(historyForIntent.slice(0, -1));
    const { extractWorkflowId } = require('../modules/release');
    const lastWorkflowId =
      extractWorkflowId(text) ||
      pending?.args?.workflowId ||
      lastWorkflowIdFromHistory(historyForIntent.slice(0, -1));

    const intent = intentRouter.classify(text, {
      hasPending,
      isConfirmation: isUserConfirmation(text),
      isCancellation: isUserCancellation(text, pending),
      pendingTool: pending?.tool || null,
      pendingArgs: pending?.args || null,
      lastIssueKey,
      lastWorkflowId,
    });

    // L2 — Plan
    const plan = buildPlan(intent, text, { hasPending });

    // L3 — Mode-scoped tools
    const confirmOn = requireConfirmation();
    const tools = toolsForIntent(intent, { confirmOn, hasPending });

    const history = historyForIntent;
    const messages = [
      { role: 'system', content: buildSystemPrompt(turnCtx, { intent, plan }) },
      ...history,
    ];

    if (intent.isWorkAgenda) {
      messages.push({
        role: 'system',
        content: [
          'This turn is a WORK AGENDA request.',
          'Call jira_my_issues if you need fresh data; synthesis will shape the final reply.',
        ].join(' '),
      });
    }

    if (intent.forceJiraGetIssue && intent.issueKey) {
      messages.push({
        role: 'system',
        content: [
          `ISSUE DETAIL: Call jira_get_issue now with issue="${intent.issueKey}"`,
          '(include_comments=true). Do not use jira_my_issues. Do not invent URLs.',
        ].join(' '),
      });
    }

    prep.end(
      `intent=${intent.domain}/${intent.mode} budget=${intent.budget} tools=${tools.length} history=${history.length} planSteps=${plan.steps.length}`
    );
    console.log(
      `[agent] intent domain=${intent.domain} mode=${intent.mode} budget=${intent.budget} reason=${intent.reason}`
    );
    console.log(`[agent] plan:\n${formatPlanForPrompt(plan)}`);

    let draft = '';

    // Capability/help asks: disable tools so the model cannot invent names like "synthesize".
    const forceNoTools = isCapabilityAsk(text);
    const activeTools = forceNoTools ? undefined : tools;
    const activeToolChoice = forceNoTools ? 'none' : undefined;

    // L4 — Tool execution loop
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const roundTimer = startTimer(`agent.round.${round}`);
      const completion = await chat({
        messages,
        tools: activeTools,
        toolChoice: activeToolChoice,
      });
      const choice = completion.choices?.[0]?.message;
      if (!choice) {
        roundTimer.end('empty response');
        throw new Error('Empty response from Groq');
      }

      const toolCalls = choice.tool_calls;
      if (toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: choice.content || null,
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const fnName = call.function?.name;
          let args = {};
          try {
            const parsed = JSON.parse(call.function?.arguments || '{}');
            args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
          } catch {
            args = {};
          }
          const normalized = coerceArgs(fnName, args);
          console.log(`[groq] tool ${fnName}`, normalized);

          // L3 policy: reject tools outside the active toolset
          if (!tools.some((t) => t.function.name === fnName)) {
            const blocked = `Error: tool ${fnName} is not allowed in this turn (mode=${intent.mode}, domain=${intent.domain}, budget=${intent.budget}).`;
            toolResults.push({ name: fnName, result: blocked });
            evidence.ingest(fnName, {
              text: blocked,
              envelope: {
                ok: false,
                source: 'policy',
                confidence: 'high',
                data: null,
                error: 'tool_not_allowed',
              },
            });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: blocked,
            });
            continue;
          }

          let payload;
          try {
            const handler = registry.getToolHandler(fnName);
            if (handler) {
              payload = await handler(normalized, turnCtx);
            } else {
              payload = await runTool(fnName, normalized, turnCtx);
            }
          } catch (err) {
            payload = asToolPayload(`Error: ${err.message || err}`, {
              ok: false,
              source: fnName,
              confidence: 'none',
              data: null,
              error: err.message || String(err),
            });
          }

          const resultText = String(payload.text);
          toolResults.push({ name: fnName, result: resultText });
          evidence.ingest(fnName, { text: resultText, envelope: payload.envelope });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: resultText.slice(0, 8000),
          });
        }
        roundTimer.end(`tool_calls=${toolCalls.map((c) => c.function?.name).join(',')}`);
        continue;
      }

      draft = (choice.content || '').trim() || '';

      // Hard gate: listing/agenda questions must call jira_my_issues this turn
      if (
        intent.forceJiraMyIssues &&
        !toolResults.some((t) => t.name === 'jira_my_issues' || t.name === 'jira_get_issue') &&
        round < MAX_TOOL_ROUNDS - 1
      ) {
        console.warn('[grounding] list/agenda request without jira_my_issues — forcing tool call');
        messages.push({ role: 'assistant', content: draft || '(draft)' });
        messages.push({
          role: 'system',
          content: intent.isWorkAgenda
            ? 'GROUNDING: Call jira_my_issues now. Synthesis will format the work agenda.'
            : [
                'GROUNDING: You answered a ticket-list question without calling jira_my_issues this turn.',
                'Call jira_my_issues now.',
                'If the user asked for all/my tickets, omit query and types.',
              ].join(' '),
        });
        roundTimer.end('force_jira_my_issues');
        continue;
      }

      // Hard gate: named-key / details follow-ups must call jira_get_issue
      if (
        intent.forceJiraGetIssue &&
        !toolResults.some((t) => t.name === 'jira_get_issue') &&
        round < MAX_TOOL_ROUNDS - 1
      ) {
        const key = intent.issueKey || 'the named key';
        console.warn(`[grounding] issue detail without jira_get_issue — forcing for ${key}`);
        messages.push({ role: 'assistant', content: draft || '(draft)' });
        messages.push({
          role: 'system',
          content: [
            `GROUNDING: Call jira_get_issue now with issue="${key}" and include_comments=true.`,
            'Do not use jira_my_issues. Do not ask the user again. Do not invent URLs.',
          ].join(' '),
        });
        roundTimer.end('force_jira_get_issue');
        continue;
      }

      // Hard gate: open-URL requests must call web_fetch_page
      if (
        intent.forceWebFetch &&
        !toolResults.some((t) => t.name === 'web_fetch_page') &&
        round < MAX_TOOL_ROUNDS - 1
      ) {
        const url = intent.pageUrl || 'the URL from the user message';
        console.warn(`[grounding] page open without web_fetch_page — forcing for ${url}`);
        messages.push({ role: 'assistant', content: draft || '(draft)' });
        messages.push({
          role: 'system',
          content: [
            `GROUNDING: Call web_fetch_page now with url="${url}" (mode=auto).`,
            'Do not use web_search. Do not claim Playwright is unavailable.',
          ].join(' '),
        });
        roundTimer.end('force_web_fetch_page');
        continue;
      }

      roundTimer.end(`model_draft chars=${draft.length} tools=${toolResults.length}`);
      break;
    }

    // L6 — Synthesize from evidence when appropriate
    let reply = draft || '(No response)';
    if (shouldSynthesize(intent, toolResults)) {
      try {
        const synthesized = await synthesize({
          userText: text,
          intent,
          plan,
          evidence,
          draft: draft || undefined,
          confirmOn,
        });
        if (synthesized) reply = synthesized;
      } catch (err) {
        console.error('[synthesize] failed, using draft:', err.message || err);
        if (!draft && toolResults.length) {
          reply = toolResults.map((t) => t.result).join('\n\n').slice(0, 1800);
        }
      }
    } else if (!draft && toolResults.length) {
      // Model returned empty but tools ran — synthesize anyway
      try {
        reply =
          (await synthesize({
            userText: text,
            intent,
            plan,
            evidence,
            confirmOn,
          })) || replyGuard.fallbackFromTools(toolResults, evidence);
      } catch {
        reply = replyGuard.fallbackFromTools(toolResults, evidence);
      }
    }

    // Prefer tool payload over a vague model empty-claim after filters
    const myIssues = toolResults.filter((t) => t.name === 'jira_my_issues').pop();
    if (
      myIssues &&
      /Assigned to you/i.test(myIssues.result) &&
      /\bno\s+(active\s+)?tickets?\b/i.test(reply) &&
      !/No (unresolved |resolved )?issues/i.test(myIssues.result)
    ) {
      const lines = String(myIssues.result)
        .split('\n')
        .filter((l) => l.startsWith('• ') || /^Assigned to you/i.test(l));
      reply = lines.slice(0, 30).join('\n') || myIssues.result.slice(0, 1500);
    }

    // L7 — Verify
    const claimCheck = replyGuard.checkReplyGrounding(reply, toolResults, evidence);
    if (!claimCheck.ok) {
      console.warn('[claim-gate]', claimCheck.reason);
      reply = await repairUngroundedReply(messages, reply, toolResults, evidence);
    }

    const note = replyGuard.compactToolNote(toolResults);
    const intentNote = `[intent: ${intent.domain}/${intent.mode}]`;
    const stored = `${reply}\n\n${intentNote}${note ? ` ${note}` : ''}`;
    conversationStore.appendMessage(channelId, userId, 'assistant', stored, discord);
    total.end(`tools=${toolResults.length} evidence=${evidence.entries.length}`);
    return reply;
  } catch (err) {
    total.end('FAILED');
    throw err;
  }
}

module.exports = {
  handleUserMessage,
  isConfigured,
  TOOLS,
  toolsForIntent,
  coerceArgs,
  coerceBoolean,
  requireConfirmation,
  isUserConfirmation,
  isUserCancellation,
  looksLikeIssueListRequest,
  looksLikeWorkSummaryRequest,
  sanitizeMyIssuesArgs,
  classifyIntent: intentRouter.classify,
  buildPlan,
};
