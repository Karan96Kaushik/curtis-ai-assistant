const registry = require('../core/moduleRegistry');
const { isCapabilityAsk } = require('../ai/planner'); // Temporary until we move it

registry.register({
  id: 'meta',
  
  intent: (text, ctx) => {
    const t = String(text || '').trim();
    if (
      /\b(clear (context|history|chat)|who am i|whoami|help|what can you do|what do you do|capabilities|how can you help|what are you)\b/i.test(t)
    ) {
      return {
        domain: 'meta',
        mode: /\b(what can you do|what do you do|capabilities|how can you help|what are you|help)\b/i.test(t) ? 'chat' : 'lookup',
        budget: 'fast',
        confidence: 'high',
        reason: 'meta',
        isCapabilityAsk: /\b(what can you do|what do you do|capabilities|how can you help|what are you|help)\b/i.test(t)
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
    }
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
    }
  },

  promptPack: (intent) => {
    return [
      'Meta mode:',
      '- clear_context clears ephemeral Discord history only (not org-memory.md).',
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
  }
});
