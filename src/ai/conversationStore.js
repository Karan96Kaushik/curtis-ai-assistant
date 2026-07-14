/**
 * In-memory conversation context keyed by Discord channel + user.
 * Not persisted across process restarts.
 */

const DEFAULT_MAX_MESSAGES = Number(process.env.DISCORD_AI_HISTORY) || 20;
const DEFAULT_TTL_MS = Number(process.env.DISCORD_AI_CONTEXT_TTL_MS) || 60 * 60 * 1000;

/** @type {Map<string, { messages: object[], discord: object, updatedAt: number }>} */
const store = new Map();

function sessionKey(channelId, userId) {
  return `${channelId}:${userId}`;
}

function getSession(channelId, userId) {
  const key = sessionKey(channelId, userId);
  const existing = store.get(key);
  if (!existing) return null;
  if (Date.now() - existing.updatedAt > DEFAULT_TTL_MS) {
    store.delete(key);
    return null;
  }
  return existing;
}

function ensureSession(channelId, userId, discordMeta = {}) {
  let session = getSession(channelId, userId);
  if (!session) {
    session = {
      messages: [],
      discord: { ...discordMeta },
      updatedAt: Date.now(),
    };
    store.set(sessionKey(channelId, userId), session);
  } else {
    session.discord = { ...session.discord, ...discordMeta };
    session.updatedAt = Date.now();
  }
  return session;
}

function appendMessage(channelId, userId, role, content, discordMeta) {
  const session = ensureSession(channelId, userId, discordMeta);
  session.messages.push({ role, content: String(content) });
  while (session.messages.length > DEFAULT_MAX_MESSAGES) {
    session.messages.shift();
  }
  session.updatedAt = Date.now();
  return session;
}

function getHistory(channelId, userId) {
  const session = getSession(channelId, userId);
  return session ? [...session.messages] : [];
}

function clearSession(channelId, userId) {
  store.delete(sessionKey(channelId, userId));
}

function getDiscordMeta(channelId, userId) {
  return getSession(channelId, userId)?.discord || null;
}

module.exports = {
  sessionKey,
  ensureSession,
  appendMessage,
  getHistory,
  clearSession,
  getDiscordMeta,
};
