require('dotenv').config();

const { Client, Events, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const { executeTask } = require('../src/discord/taskRunner');
const discordAgent = require('../src/ai/discordAgent');
const { DEFAULT_MODEL } = require('../src/integrations/groqClient');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID;
const BOT_PERMISSIONS = process.env.DISCORD_BOT_PERMISSIONS || '2147568640';
const COMMAND_PREFIX = process.env.DISCORD_COMMAND_PREFIX || '!';
const MESSAGE_COMMANDS_ENABLED = process.env.DISCORD_MESSAGE_COMMANDS !== '0';
const AI_ENABLED = process.env.DISCORD_AI !== '0' && discordAgent.isConfigured();
const AI_LISTEN_ALL = process.env.DISCORD_AI_LISTEN === 'all';

if (!BOT_TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN in .env');
  process.exit(1);
}

const KNOWN_COMMANDS = new Set([
  'jira-update',
  'jira-my-issues',
  'jira-create',
  'jira-whoami',
  'help',
]);

function truncate(content) {
  const text = String(content);
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

function installUrl() {
  if (!APP_ID) return null;
  const params = new URLSearchParams({
    client_id: APP_ID,
    permissions: BOT_PERMISSIONS,
    scope: 'bot applications.commands',
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

function helpText() {
  const p = COMMAND_PREFIX;
  const lines = [
    'Commands (slash or message):',
    `\`${p}jira-my-issues [--max N] [--status Name]\``,
    `\`${p}jira-update --issue KEY [--status Name] [--comment Text]\``,
    `\`${p}jira-create --project KEY --summary Text [--type Task] [--description Text] [--assign-me]\``,
    `\`${p}jira-whoami\``,
  ];
  if (AI_ENABLED) {
    lines.push(
      '',
      'AI (Groq): mention me or DM with natural language, e.g.',
      '`@bot what are my open tickets?`',
      '`@bot comment on AATP-47 saying started`',
      `Model: ${DEFAULT_MODEL}`
    );
  }
  return lines.join('\n');
}

function tokenize(input) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function parseFlags(tokens) {
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--')) continue;

    const rawKey = token.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    if (rawKey === 'assign-me' || rawKey === 'assign_me') {
      flags.assignToMe = true;
      continue;
    }

    const next = tokens[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

/**
 * @returns {{ kind: 'prefix', name: string, flags: object } | { kind: 'ai', text: string } | null}
 */
function classifyMessage(content, clientUser) {
  let text = content.trim();
  if (!text) return null;

  const mentionRe = new RegExp(`^<@!?${clientUser.id}>\\s*`);
  const mentioned = mentionRe.test(text);
  if (mentioned) {
    text = text.replace(mentionRe, '').trim();
  }

  if (text.startsWith(COMMAND_PREFIX)) {
    const body = text.slice(COMMAND_PREFIX.length).trim();
    if (!body) return { kind: 'prefix', name: 'help', flags: {} };
    const tokens = tokenize(body);
    const name = tokens[0]?.toLowerCase();
    if (name && KNOWN_COMMANDS.has(name)) {
      return { kind: 'prefix', name, flags: parseFlags(tokens.slice(1)) };
    }
    // Unknown !command → AI if enabled
    if (AI_ENABLED) {
      return { kind: 'ai', text: body };
    }
    return { kind: 'prefix', name: 'help', flags: { unknown: name || '(empty)' } };
  }

  if (mentioned && text) {
    if (AI_ENABLED) return { kind: 'ai', text };
    // Mention without AI: try first token as command
    const tokens = tokenize(text);
    const name = tokens[0]?.toLowerCase();
    if (name && KNOWN_COMMANDS.has(name)) {
      return { kind: 'prefix', name, flags: parseFlags(tokens.slice(1)) };
    }
    return { kind: 'prefix', name: 'help', flags: {} };
  }

  return null;
}

function discordContextFromMessage(message) {
  return {
    userId: message.author.id,
    username: message.author.username,
    displayName: message.member?.displayName || message.author.displayName || message.author.username,
    channelId: message.channel.id,
    guildId: message.guild?.id || null,
    channelType: message.channel.type,
  };
}

async function runPrefixCommand(name, flags) {
  if (name === 'help') {
    if (flags.unknown) {
      return `Unknown command \`${flags.unknown}\`.\n${helpText()}`;
    }
    return helpText();
  }
  return executeTask(name, flags);
}

async function handleSlashCommand(interaction) {
  const name = interaction.commandName;
  console.log(`Slash command: /${name}`);
  await interaction.deferReply();

  let payload = {};
  if (name === 'jira-update') {
    payload = {
      issue: interaction.options.getString('issue'),
      status: interaction.options.getString('status') || undefined,
      comment: interaction.options.getString('comment') || undefined,
    };
  } else if (name === 'jira-my-issues') {
    payload = {
      max: interaction.options.getInteger('max') || undefined,
      status: interaction.options.getString('status') || undefined,
    };
  } else if (name === 'jira-create') {
    payload = {
      project: interaction.options.getString('project'),
      summary: interaction.options.getString('summary'),
      type: interaction.options.getString('type') || undefined,
      description: interaction.options.getString('description') || undefined,
      assignToMe: interaction.options.getBoolean('assign_me') || false,
    };
  } else if (name === 'jira-whoami') {
    payload = {};
  } else {
    await interaction.editReply({ content: `Unknown command \`/${name}\`.` });
    return;
  }

  try {
    const content = await executeTask(name, payload);
    await interaction.editReply({ content: truncate(content) });
  } catch (err) {
    console.error(`/${name} failed:`, err.message || err);
    await interaction.editReply({ content: truncate(`Error: ${err.message || err}`) });
  }
}

async function replyWorking(message) {
  return message.reply({ content: 'Working…' }).catch(() => null);
}

async function finishReply(message, thinking, body) {
  const text = truncate(body);
  if (thinking) {
    await thinking.edit(text).catch(() => message.reply(text));
  } else {
    await message.reply(text);
  }
}

async function handleMessage(message) {
  if (message.author.bot) return;

  const isDm = message.channel.type === ChannelType.DM;
  let classified = classifyMessage(message.content, message.client.user);

  // DMs / listen-all → natural language via AI when not a prefix command
  if (!classified && AI_ENABLED && (isDm || AI_LISTEN_ALL)) {
    const text = message.content.trim();
    if (text) classified = { kind: 'ai', text };
  }

  if (!classified) return;

  const thinking = await replyWorking(message);

  try {
    let content;
    if (classified.kind === 'prefix') {
      console.log(`Message command: ${COMMAND_PREFIX}${classified.name} from ${message.author.tag}`);
      content = await runPrefixCommand(classified.name, classified.flags);
    } else {
      console.log(`AI message from ${message.author.tag}: ${classified.text.slice(0, 80)}`);
      content = await discordAgent.handleUserMessage({
        text: classified.text,
        discord: discordContextFromMessage(message),
      });
    }
    await finishReply(message, thinking, content);
  } catch (err) {
    console.error('Message handling failed:', err.message || err);
    await finishReply(message, thinking, `Error: ${err.message || err}`);
  }
}

const needMessages = MESSAGE_COMMANDS_ENABLED || AI_ENABLED;
const intents = [GatewayIntentBits.Guilds];
if (needMessages) {
  intents.push(
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  );
}

const client = new Client({
  intents,
  partials: needMessages ? [Partials.Channel] : [],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord gateway connected as ${readyClient.user.tag}`);
  if (AI_ENABLED) {
    console.log(`Groq AI enabled (model=${DEFAULT_MODEL}) — mention/DM natural language`);
    if (AI_LISTEN_ALL) console.log('DISCORD_AI_LISTEN=all — all channel messages routed to AI');
  } else if (!discordAgent.isConfigured()) {
    console.log('Groq AI disabled (set GROQ_API_KEY to enable).');
  } else {
    console.log('Groq AI disabled (DISCORD_AI=0).');
  }
  if (needMessages) {
    console.log(`Prefix commands: "${COMMAND_PREFIX}" — MESSAGE CONTENT INTENT required in portal.`);
  } else {
    console.log('Slash commands only.');
  }
  const url = installUrl();
  if (url) console.log(`Invite/install URL: ${url}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleSlashCommand(interaction);
  } catch (err) {
    console.error('Unhandled slash error:', err);
    const payload = { content: truncate(`Error: ${err.message || err}`) };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply(payload);
    } catch (replyErr) {
      console.error('Failed to send error reply:', replyErr.message || replyErr);
    }
  }
});

if (needMessages) {
  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      console.error('Unhandled message error:', err);
    }
  });
}

client.login(BOT_TOKEN).catch((err) => {
  const message = err.message || String(err);
  console.error('Gateway login failed:', message);
  if (/disallowed intents/i.test(message)) {
    console.error(`
This usually means MESSAGE CONTENT INTENT is not enabled.

Fix:
  1. https://discord.com/developers/applications → Bot → Privileged Gateway Intents
  2. Enable MESSAGE CONTENT INTENT, save, then npm start
  3. Or set DISCORD_MESSAGE_COMMANDS=0 and DISCORD_AI=0 for slash-only
`);
  }
  process.exit(1);
});
