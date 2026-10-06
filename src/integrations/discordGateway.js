/**
 * Live Discord.js client handle so tools can act on the current channel.
 * bot/client.js registers the client on gateway ready.
 */

const { PermissionFlagsBits } = require('discord.js');

const MAX_DELETE = 500;
const BATCH = 100;

let client = null;

function setClient(c) {
  client = c || null;
}

function getClient() {
  return client;
}

async function getChannel(channelId) {
  if (!client || !channelId) return null;
  const cached = client.channels.cache.get(channelId);
  if (cached) return cached;
  try {
    return await client.channels.fetch(channelId);
  } catch {
    return null;
  }
}

function canManageMessages(channel) {
  if (!channel?.guild) return false;
  try {
    const me = channel.guild.members.me;
    return Boolean(channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages));
  } catch {
    return false;
  }
}

async function deleteOwn(messages, botId) {
  let deleted = 0;
  let skipped = 0;
  for (const msg of messages.values()) {
    if (msg.pinned || msg.author?.id !== botId) {
      skipped += 1;
      continue;
    }
    try {
      await msg.delete();
      deleted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { deleted, skipped };
}

/**
 * Delete recent messages in a Discord channel.
 * Guild channels: bulk-delete when Manage Messages is granted (14-day cap).
 * DMs / no permission: only Curtis's own messages.
 *
 * @param {string} channelId
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   deleted: number,
 *   skipped: number,
 *   dm: boolean,
 *   error?: string,
 *   warning?: string,
 * }>}
 */
async function clearChannelMessages(channelId, opts = {}) {
  if (!client) {
    return { ok: false, deleted: 0, skipped: 0, dm: false, error: 'discord_offline' };
  }

  const channel = await getChannel(channelId);
  if (!channel?.isTextBased?.()) {
    return { ok: false, deleted: 0, skipped: 0, dm: false, error: 'not_text_channel' };
  }

  const botId = client.user?.id;
  const cap = Math.min(Math.max(Number(opts.limit) || 100, 1), MAX_DELETE);
  const dm = Boolean(channel.isDMBased?.());
  let deleted = 0;
  let skipped = 0;
  let remaining = cap;
  let warning;

  while (remaining > 0) {
    const batchSize = Math.min(remaining, BATCH);
    let fetched;
    try {
      fetched = await channel.messages.fetch({ limit: batchSize });
    } catch (err) {
      return {
        ok: deleted > 0,
        deleted,
        skipped,
        dm,
        error: err.message || 'fetch_failed',
        warning,
      };
    }
    if (!fetched.size) break;

    const deletedBefore = deleted;

    if (dm || !canManageMessages(channel) || typeof channel.bulkDelete !== 'function') {
      if (!dm && !warning) {
        warning =
          'Missing Manage Messages — deleted Curtis’s own messages only. Re-invite the bot with that permission to wipe others’ messages.';
      }
      if (dm && !warning) {
        warning = 'In DMs Discord only lets Curtis delete his own messages, not yours.';
      }
      const own = await deleteOwn(fetched, botId);
      deleted += own.deleted;
      skipped += own.skipped;
      break;
    }

    const candidates = fetched.filter((m) => !m.pinned);
    skipped += fetched.size - candidates.size;

    if (candidates.size === 0) break;

    try {
      const result = await channel.bulkDelete(candidates, true);
      deleted += result.size;
      const leftover = candidates.filter((m) => !result.has(m.id));
      const ownOld = await deleteOwn(leftover, botId);
      deleted += ownOld.deleted;
      skipped += ownOld.skipped;
    } catch (err) {
      warning = warning || err.message || 'bulk_delete_failed';
      const own = await deleteOwn(candidates, botId);
      deleted += own.deleted;
      skipped += own.skipped;
      break;
    }

    if (deleted === deletedBefore) break;
    remaining -= fetched.size;
    if (fetched.size < batchSize) break;
  }

  return { ok: true, deleted, skipped, dm, warning };
}

module.exports = {
  setClient,
  getClient,
  getChannel,
  clearChannelMessages,
};
