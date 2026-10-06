const registry = require('../core/moduleRegistry');
const { isCapabilityAsk } = require('../ai/planner'); // Temporary until we move it

const CLEAR_CHAT_RE =
  /\b((clear|wipe|purge|empty)\s+(out\s+)?(the\s+|this\s+|my\s+)?(discord\s+)?(chat|channel)|(clear|wipe|purge|delete|empty)\s+(the\s+|this\s+|my\s+)?discord(\s+(chat|channel|messages?))?|delete\s+(the\s+|this\s+|my\s+)?(discord\s+)?chat)\b/i;

registry.register({
  id: 'meta',
  
  intent: (text, ctx) => {
    const t = String(text || '').trim();
    if (
      CLEAR_CHAT_RE.test(t) ||
      /\b(clear (context|history|chat)|who am i|whoami|help|what can you do|what do you do|capabilities|how can you help|what are you)\b/i.test(t)
    ) {
      const isClearChat = CLEAR_CHAT_RE.test(t);
      const isCapabilityAsk =
        !isClearChat &&
        /\b(what can you do|what do you do|capabilities|how can you help|what are you|help)\b/i.test(t);
      return {
        domain: 'meta',
        mode: isCapabilityAsk ? 'chat' : isClearChat ? 'mutate' : 'lookup',
        budget: 'fast',
        confidence: 'high',
        reason: isClearChat ? 'clear-chat' : 'meta',
        isCapabilityAsk,
        isClearChat,
      };
    }
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'think',
        description: 'Private scratchpad for structuring multi-step reasoning. Not shown to the user. Use before complex plans.',
        parameters: {
          type: 'object',
          properties: {
            thought: { type: 'string', description: 'Brief internal reasoning / plan notes' },
          },
          required: ['thought'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'clear_context',
        description: 'Clear this Discord conversation memory for the current user in this channel (does not clear org-memory.md). Also clears any pending action.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'clear_chat',
        description:
          'Delete recent Discord messages in this channel and clear conversation memory for everyone in it. Does not touch org-memory.md. In DMs, only Curtis’s own messages can be deleted. Guild wipe of other people’s messages needs Manage Messages. Discord cannot bulk-delete messages older than 14 days.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max messages to scan (default 100, max 500)',
            },
          },
        },
      },
    },
  ],

  toolHandlers: {
    think: async (args) => {
      const thought = args.thought != null ? String(args.thought) : '';
      return {
        text: `Scratchpad noted (${thought.length} chars).`,
        envelope: { ok: true, source: 'think', confidence: 'high', data: { thought } }
      };
    },
    clear_context: async (args, discordCtx) => {
      const conversationStore = require('../ai/conversationStore');
      const pendingActions = require('../ai/pendingActions');
      conversationStore.clearSession(discordCtx.channelId, discordCtx.userId);
      pendingActions.clear(discordCtx.channelId, discordCtx.userId);
      return {
        text: 'Conversation context cleared for this channel (org memory unchanged). Pending action cleared.',
        envelope: { ok: true, source: 'meta', confidence: 'high', data: { cleared: true } }
      };
    },
    clear_chat: async (args, discordCtx) => {
      const conversationStore = require('../ai/conversationStore');
      const pendingActions = require('../ai/pendingActions');
      const discordGateway = require('../integrations/discordGateway');
      const channelId = discordCtx?.channelId;
      if (!channelId) {
        return {
          text: 'No Discord channel on this session, so nothing was deleted.',
          envelope: {
            ok: false,
            source: 'meta',
            confidence: 'high',
            data: { cleared: false, deleted: 0, error: 'no_channel' },
          },
        };
      }
      conversationStore.clearChannel(channelId);
      pendingActions.clearChannel(channelId);

      const result = await discordGateway.clearChannelMessages(channelId, { limit: args?.limit });
      const bits = [];
      if (result.ok) {
        if (result.deleted) bits.push(`Deleted ${result.deleted} Discord message(s) in this channel.`);
        else bits.push('No Discord messages were deleted.');
        if (result.skipped) bits.push(`Skipped ${result.skipped} (pinned, too old, or not deletable).`);
      } else if (result.error === 'discord_offline') {
        bits.push('Discord client is not connected, so channel messages were not deleted.');
      } else {
        bits.push(`Could not delete Discord messages (${result.error || 'unknown error'}).`);
      }
      bits.push('Conversation memory cleared for this channel (org memory unchanged).');
      if (result.warning) bits.push(result.warning);

      return {
        text: bits.join(' '),
        envelope: {
          ok: result.ok || result.deleted > 0,
          source: 'meta',
          confidence: 'high',
          data: {
            cleared: true,
            deleted: result.deleted,
            skipped: result.skipped,
            dm: result.dm,
            warning: result.warning || null,
            error: result.error || null,
          },
        },
      };
    },
  },

  promptPack: (intent) => {
    return [
      'Meta mode:',
      '- clear_chat deletes recent Discord messages in this channel and clears ephemeral memory (not org-memory.md). Use when the user asks to clear/wipe the chat.',
      '- clear_context clears ephemeral Discord history only (not org-memory.md, not Discord messages).',
      '- jira_whoami shows the authenticated Jira account.',
    ].join('\n');
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.isCapabilityAsk) {
      pushGuidance(
        'answer_in_plain_text',
        'Describe capabilities from org memory / system knowledge. Do NOT call any tools.'
      );
    } else if (intent.domain === 'meta') {
      if (/\bwhoami|who am i\b/i.test(userText)) {
        pushTool('jira_whoami', 'Show authenticated Jira account');
      } else if (intent.isClearChat || CLEAR_CHAT_RE.test(userText)) {
        pushTool('clear_chat', 'Delete Discord messages in this channel and clear conversation memory');
      } else if (/\bclear\b/i.test(userText)) {
        pushTool('clear_context', 'Clear ephemeral Discord conversation memory');
      } else {
        pushGuidance('answer_in_plain_text', 'Meta/help answer in plain text; tools only if needed');
      }
    }
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (tool === 'think' && envelope.data?.thought) {
      out.push({ type: 'scratchpad', value: String(envelope.data.thought).slice(0, 500) });
    }
    if (tool === 'clear_context' && envelope.data?.cleared) {
      out.push({ type: 'side_effect', value: 'Conversation context cleared' });
    }
    if (tool === 'clear_chat' && envelope.data?.cleared) {
      const n = envelope.data.deleted != null ? envelope.data.deleted : '?';
      out.push({ type: 'side_effect', value: `Discord chat cleared (${n} messages deleted)` });
    }
  }
});
