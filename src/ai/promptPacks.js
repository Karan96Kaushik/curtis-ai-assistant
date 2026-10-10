const registry = require('../core/moduleRegistry');

/** Where Curtis is running; set CURTIS_SURFACE=web for the Amplify chat app. */
const SURFACES = {
  discord: {
    persona:
      'You are Curtis, a helpful Discord assistant for Jira, GitHub, org context, light web research, and (when the Firefox extension is connected) browser/Teams actions at Flexible Power Systems.',
    clearChat:
      'If asked to clear/wipe the Discord chat, call clear_chat (that deletes channel messages). clear_context only forgets memory.',
  },
  web: {
    persona:
      'You are Curtis, a helpful assistant in a web chat app for Jira, GitHub, org context, release workflows, light web research, the user\'s phone notifications, and outbound Android push alerts at Flexible Power Systems. Browser, Microsoft Teams, and scheduled tasks are not available in the web app. Phone notifications are private (email, promotions, one-time codes, and messages). Call request_phone_notifications with a duration_minutes from 1 to 1440, then wait for the user to confirm. Never claim you saw a notification that was not in a confirmed phone notification context. To alert the user\'s phone, call send_push_notification immediately (no confirmation) with a title and body you choose.',
    clearChat:
      'If asked to clear the chat, call clear_context (that forgets this conversation’s memory; the user can start a new chat from the sidebar).',
  },
};

function identityPack() {
  const surface = SURFACES[process.env.CURTIS_SURFACE] || SURFACES.discord;
  return [
    surface.persona,
    'Be fluid and proactive: do useful work in one turn when the intent is clear.',
    'Prefer action over clarifying questions unless a required field is missing.',
    'Sound natural — avoid stock closers like "What would you like to do next?".',
    surface.clearChat,
  ].join('\n');
}

function fluidPack() {
  return [
    'Fluid conversation:',
    '- Interpret short follow-ups ("all", "broader", "try again", "those", "yes", "details", "pull details") in context.',
    '- Affirmatives after you offered to fetch data → invoke the tool immediately; do not re-offer.',
    '- Prefer a generous useful answer over an empty over-filtered miss.',
    '- Never invent Jira issue types (Story/Epic) unless the user named them.',
    '- Never invent Jira URLs or domains — only paste URL fields from tool results.',
  ].join('\n');
}

function groundingPack() {
  return [
    'Grounding (required):',
    '- Factual claims must come from THIS turn’s tool evidence or Org memory.',
    '- Your capabilities, identity, and rules are provided in Org memory and can be cited without tool evidence.',
    '- Never claim a side effect succeeded unless a write tool in THIS turn returned success.',
    '- If a tool errors or returns mock/low-confidence data, say so plainly.',
    '- If you lack evidence for a named ticket, call jira_get_issue — do not claim it is missing from "the current dataset" and stop.',
    '- If the user gives a github.com link, use github_* tools (the GitHub client). Never web_fetch_page or scrape github.com.',
    '- Chat history can contradict tools; THIS turn’s tools win. Do not gaslight the user about keys that appeared earlier.',
  ].join('\n');
}

/**
 * Assemble mode packs for this turn’s intent.
 * @param {object} intent
 * @param {{ confirmOn?: boolean }} [opts]
 */
function packsForIntent(intent, opts = {}) {
  const packs = [identityPack(), fluidPack(), groundingPack()];
  
  // Get prompt pack from the module that owns this domain
  const modulePack = registry.getPromptPack(intent.domain, intent, opts);
  if (modulePack) {
    packs.push(modulePack);
  } else if (intent.domain === 'mixed') {
    // If it's a mixed intent, we might want to include multiple packs
    // For now, let's keep it simple, or iterate through modules to see if they apply.
    for (const [id, packFn] of registry.promptPacks.entries()) {
      const pack = packFn(intent, opts);
      if (pack) packs.push(pack);
    }
  }

  // Push is always available on web; surface its rules even when the domain is jira/github/etc.
  if (process.env.CURTIS_SURFACE === 'web' && intent.domain !== 'push' && intent.domain !== 'mixed') {
    const pushPack = registry.getPromptPack('push', intent, opts);
    if (pushPack) packs.push(pushPack);
  }

  return packs.join('\n\n');
}

module.exports = {
  identityPack,
  fluidPack,
  groundingPack,
  packsForIntent,
};
