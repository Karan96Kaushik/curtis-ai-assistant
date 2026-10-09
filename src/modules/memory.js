const registry = require('../core/moduleRegistry');
const orgMemory = require('../ai/orgMemory');
const storedContexts = require('../ai/storedContexts');

registry.register({
  id: 'memory',

  intent: (text) => {
    const t = String(text || '').trim();
    const memWrite = /\b(remember|keep (this )?for later|update (the )?(context|memory|org memory)|save (this|that) (to|in) memory|don'?t forget)\b/i.test(t);
    const memRead = /\b(what do you remember|org memory|show memory|read memory|what('s| is) (in )?context)\b/i.test(t);
    
    if (memWrite) {
      return { domain: 'memory', mode: 'mutate', needsConfirm: false, budget: 'fast', confidence: 'high', reason: 'memory-write' };
    }
    if (memRead) {
      return { domain: 'memory', mode: 'lookup', budget: 'fast', confidence: 'high', reason: 'memory-read' };
    }
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'memory_append',
        description: 'Append durable org facts to org-memory.md. Required for "remember / update context / keep this for later". Returns a verified re-read preview.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Markdown chunk to append' },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_write',
        description: 'Replace the entire org-memory.md file. Prefer memory_append for small updates.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Full markdown content for org-memory.md' },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_read',
        description: 'Read current org-memory.md (or a tail).',
        parameters: {
          type: 'object',
          properties: {
            max_chars: { type: 'integer', description: 'Max characters from the end (default 4000).' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'context_list',
        description: 'List stored reference contexts (org memory, specs, and other documents). Does not include behavior memory.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'context_read',
        description: 'Read one stored reference context by slug (for example org-memory or a saved spec).',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Context slug from context_list.' },
          },
          required: ['slug'],
        },
      },
    }
  ],

  toolHandlers: {
    memory_append: async (args) => {
      const text = args.text != null ? String(args.text) : '';
      if (!text.trim()) {
        return {
          text: 'Error: memory_append requires non-empty text',
          envelope: { ok: false, source: 'org-memory', confidence: 'high', data: null, error: 'empty' }
        };
      }
      try {
        const result = orgMemory.append(text);
        if (result.skipped) {
          return {
            text: `Error: nothing appended — ${result.reason || 'empty after dedupe'}. Path: ${orgMemory.getPath()}`,
            envelope: { ok: false, source: 'org-memory', confidence: 'high', data: result, error: result.reason }
          };
        }
        const out = orgMemory.formatWriteResult({ action: 'append', appended: result.appended });
        return {
          text: out,
          envelope: { ok: true, source: 'org-memory', confidence: 'high', data: { action: 'append', appended: result.appended } }
        };
      } catch (err) {
        return {
          text: `Error: memory_append failed: ${err.message || err}`,
          envelope: { ok: false, source: 'org-memory', confidence: 'high', data: null, error: err.message || String(err) }
        };
      }
    },
    memory_write: async (args) => {
      const content = args.content != null ? String(args.content) : '';
      try {
        orgMemory.write(content);
        const out = orgMemory.formatWriteResult({ action: 'write' });
        return {
          text: out,
          envelope: { ok: true, source: 'org-memory', confidence: 'high', data: { action: 'write' } }
        };
      } catch (err) {
        return {
          text: `Error: memory_write failed: ${err.message || err}`,
          envelope: { ok: false, source: 'org-memory', confidence: 'high', data: null, error: err.message || String(err) }
        };
      }
    },
    memory_read: async (args) => {
      const maxChars = Math.min(Math.max(Number(args.max_chars) || 4000, 200), 12000);
      const full = orgMemory.read();
      const body = full.length <= maxChars ? full : `…(truncated)\n${full.slice(-maxChars)}`;
      const text = [
        `Org memory path: ${orgMemory.getPath()}`,
        `Bytes: ${Buffer.byteLength(full, 'utf8')}`,
        '',
        body || '(empty)',
      ].join('\n');
      return {
        text,
        envelope: { ok: true, source: 'org-memory', confidence: 'high', data: { bytes: Buffer.byteLength(full, 'utf8') } }
      };
    },
    context_list: async () => {
      const rows = storedContexts.listEntries();
      const text = rows.length
        ? ['Stored contexts:', ...rows.map((row) => `- ${row.slug}: ${row.title}`)].join('\n')
        : 'No stored contexts.';
      return {
        text,
        envelope: { ok: true, source: 'contexts', confidence: 'high', data: { count: rows.length } },
      };
    },
    context_read: async (args) => {
      const slug = args.slug != null ? String(args.slug).trim() : '';
      if (!slug) {
        return {
          text: 'Error: context_read requires a slug. Call context_list first.',
          envelope: { ok: false, source: 'contexts', confidence: 'high', data: null, error: 'empty' },
        };
      }
      try {
        const body = storedContexts.clip(storedContexts.readBySlug(slug));
        const text = body.trim() ? `Context ${slug}:\n\n${body}` : `Context ${slug} is empty or not stored.`;
        return {
          text,
          envelope: { ok: true, source: 'contexts', confidence: 'high', data: { slug, bytes: Buffer.byteLength(body, 'utf8') } },
        };
      } catch (err) {
        return {
          text: `Error: context_read failed: ${err.message || err}`,
          envelope: { ok: false, source: 'contexts', confidence: 'high', data: null, error: err.message || String(err) },
        };
      }
    },
  },

  promptPack: () => {
    return [
      'Memory mode:',
      '- "Remember / keep for later" → memory_append (prefer) or memory_write.',
      '- "What do you remember?" → memory_read.',
      '- Prefer short domain lessons + key tickets, not huge dumps.',
      '- Specs and other saved documents: context_list, then context_read. Do not invent their contents.',
      '- Behavior preferences are already in the prompt when the user has approved them. Do not write behavior memory yourself.',
    ].join('\n');
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.domain === 'memory' || (intent.domain === 'mixed' && /remember|memory|context/i.test(userText))) {
      if (/remember|keep|save|update/i.test(userText)) {
        pushTool('memory_append', 'Persist durable org facts (prefer append over write)');
      } else {
        pushTool('memory_read', 'Read org memory for the answer');
      }
    }
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (/Appended to org memory|Wrote org memory/i.test(text)) {
      out.push({ type: 'side_effect', value: text.split('\n')[0].slice(0, 160) });
    }
  }
});
