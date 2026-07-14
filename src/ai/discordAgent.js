const { chat, isConfigured, DEFAULT_MODEL } = require('../integrations/groqClient');
const conversationStore = require('./conversationStore');
const { executeTask } = require('../discord/taskRunner');

const MAX_TOOL_ROUNDS = 5;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'jira_my_issues',
      description:
        'List unresolved Jira issues assigned to the authenticated Jira user (from .env credentials).',
      parameters: {
        type: 'object',
        properties: {
          max: {
            type: 'integer',
            description: 'Max issues to return (1-50). Default 25.',
          },
          status: {
            type: 'string',
            description: 'Optional status name filter, e.g. "In Progress".',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jira_update',
      description:
        'Update a Jira issue: transition status and/or add a comment. At least one of status or comment required.',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
          status: { type: 'string', description: 'Transition/status name to apply' },
          comment: { type: 'string', description: 'Comment text to post on the issue' },
        },
        required: ['issue'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jira_create',
      description: 'Create a new Jira issue in a project.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project key, e.g. AATP' },
          summary: { type: 'string', description: 'Issue summary / title' },
          type: { type: 'string', description: 'Issue type name. Default Task.' },
          description: { type: 'string', description: 'Optional description' },
          assign_me: {
            type: 'boolean',
            description: 'If true, assign the issue to the Jira auth user',
          },
        },
        required: ['project', 'summary'],
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
      name: 'clear_context',
      description: 'Clear this Discord conversation memory for the current user in this channel.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function buildSystemPrompt(discordCtx) {
  const when = new Date().toISOString();
  return [
    'You are a helpful Discord assistant that can manage Jira tasks for a single configured Jira Cloud account.',
    'Use tools when the user asks to list, update, or create Jira issues, or to check Jira auth.',
    'Keep Discord replies concise (under ~1800 characters). Prefer short bullet lists for tickets.',
    'If required details are missing (issue key, project, summary), ask a brief clarifying question instead of guessing.',
    'Do not invent issue keys or pretend a tool succeeded — always use tools for Jira actions.',
    'You are talking to one Discord user in a channel; use conversation history for context.',
    '',
    'Discord session context:',
    `- UTC time: ${when}`,
    `- Discord user: ${discordCtx.displayName || discordCtx.username} (id=${discordCtx.userId})`,
    `- Username: ${discordCtx.username}`,
    `- Channel id: ${discordCtx.channelId}`,
    `- Guild id: ${discordCtx.guildId || '(DM)'}`,
    `- Channel type: ${discordCtx.channelType || 'unknown'}`,
    '',
    `Model: ${DEFAULT_MODEL} via Groq.`,
  ].join('\n');
}

async function runTool(name, args, discordCtx) {
  if (name === 'clear_context') {
    conversationStore.clearSession(discordCtx.channelId, discordCtx.userId);
    return 'Conversation context cleared for this channel.';
  }

  if (name === 'jira_my_issues') {
    return executeTask('jira-my-issues', {
      max: args.max,
      status: args.status,
    });
  }

  if (name === 'jira_update') {
    return executeTask('jira-update', {
      issue: args.issue,
      status: args.status,
      comment: args.comment,
    });
  }

  if (name === 'jira_create') {
    return executeTask('jira-create', {
      project: args.project,
      summary: args.summary,
      type: args.type,
      description: args.description,
      assignToMe: args.assign_me,
    });
  }

  if (name === 'jira_whoami') {
    return executeTask('jira-whoami');
  }

  return `Unknown tool: ${name}`;
}

/**
 * Handle a natural-language Discord message with Groq + tools.
 * @param {{ text: string, discord: object }} input
 * @returns {Promise<string>}
 */
async function handleUserMessage({ text, discord }) {
  if (!isConfigured()) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const { channelId, userId } = discord;
  conversationStore.ensureSession(channelId, userId, discord);
  conversationStore.appendMessage(channelId, userId, 'user', text, discord);

  const history = conversationStore.getHistory(channelId, userId);
  const messages = [
    { role: 'system', content: buildSystemPrompt(discord) },
    ...history,
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await chat({ messages, tools: TOOLS });
    const choice = completion.choices?.[0]?.message;
    if (!choice) {
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
        console.log(`[groq] tool ${fnName}`, args);
        let result;
        try {
          result = await runTool(fnName, args, discord);
        } catch (err) {
          result = `Error: ${err.message || err}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: String(result).slice(0, 8000),
        });
      }
      continue;
    }

    const reply = (choice.content || '').trim() || '(No response)';
    conversationStore.appendMessage(channelId, userId, 'assistant', reply, discord);
    return reply;
  }

  const fallback = 'I hit the tool-call limit. Try a simpler request.';
  conversationStore.appendMessage(channelId, userId, 'assistant', fallback, discord);
  return fallback;
}

module.exports = {
  handleUserMessage,
  isConfigured,
  TOOLS,
};
