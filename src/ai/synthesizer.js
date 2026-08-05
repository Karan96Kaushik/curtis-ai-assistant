/**
 * L6 — Final synthesis pass (no tools): answer from evidence + mode pack only.
 */

const { chat } = require('../integrations/groqClient');
const { packsForIntent } = require('./promptPacks');
const { formatPlanForPrompt } = require('./planner');
const { startTimer } = require('../util/timing');

/**
 * @param {{
 *   userText: string,
 *   intent: object,
 *   plan: object,
 *   evidence: { summaryForPrompt: () => string },
 *   draft?: string,
 *   confirmOn?: boolean,
 * }} opts
 * @returns {Promise<string>}
 */
async function synthesize(opts) {
  const timer = startTimer('agent.synthesize');
  const modeRules = packsForIntent(opts.intent, { confirmOn: opts.confirmOn !== false });
  const evidenceBlock = opts.evidence.summaryForPrompt();
  const planBlock = formatPlanForPrompt(opts.plan);

  const messages = [
    {
      role: 'system',
      content: [
        'You are in SYNTHESIS mode. Do not call tools. Write the user-facing Discord reply.',
        modeRules,
        '',
        'Turn plan:',
        planBlock,
        '',
        'Evidence ledger (ONLY source of factual claims):',
        evidenceBlock,
        '',
        'Rules:',
        '- Use only evidence above (plus obvious conversational glue).',
        '- If evidence is mock/low-confidence/empty/error, disclose that.',
        '- Keep under ~1800 characters.',
        '- No stock closers.',
      ].join('\n'),
    },
    { role: 'user', content: opts.userText },
  ];

  if (opts.draft) {
    messages.push({
      role: 'assistant',
      content: opts.draft,
    });
    messages.push({
      role: 'system',
      content:
        'Revise the draft above so every factual claim is supported by the evidence ledger. Remove unsupported claims.',
    });
  }

  try {
    const completion = await chat({
      messages,
      toolChoice: 'none',
      temperature: 0.2,
    });
    const reply = (completion.choices?.[0]?.message?.content || '').trim();
    timer.end(reply ? `chars=${reply.length}` : 'empty');
    return reply;
  } catch (err) {
    timer.end('FAILED');
    throw err;
  }
}

module.exports = { synthesize };
