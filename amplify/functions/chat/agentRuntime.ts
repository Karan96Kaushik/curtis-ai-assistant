import fs from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import discordAgent from '../../../src/ai/discordAgent.js';
import conversationStoreModule from '../../../src/ai/conversationStore.js';
import pendingActionsModule from '../../../src/ai/pendingActions.js';
import registry from '../../../src/core/moduleRegistry.js';
import phoneNotifications from '../../../src/ai/phoneNotifications.js';
import pushNotificationsModule from '../../../src/ai/pushNotifications.js';
import { sendPushToUser } from '../_shared/fcm.js';
import { readPhoneNotifications } from '../_shared/readPhoneNotifications.js';
import { HttpError } from '../_shared/http.js';
import { cancelScheduledJob, createScheduledJob, listScheduledJobs } from '../_shared/scheduledJobs.js';
import webSchedulerModule from '../../../src/modules/webScheduler.js';

/** The slices of the JS stores used here, typed more precisely than their JSDoc. */
interface ConversationStoreApi {
  appendMessage(channelId: string, userId: string, role: string, content: string, meta: object): unknown;
  getHistory(channelId: string, userId: string): AgentMessage[];
  clearSession(channelId: string, userId: string): void;
}

interface PendingEntry {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  turnId: string | null;
  createdAt: number;
}

interface PendingActionsApi {
  set(channelId: string, userId: string, entry: Omit<PendingEntry, 'createdAt'>): PendingEntry;
  get(channelId: string, userId: string): PendingEntry | null;
  clear(channelId: string, userId: string): void;
}

const conversationStore = conversationStoreModule as unknown as ConversationStoreApi;
const pendingActions = pendingActionsModule as unknown as PendingActionsApi;

const pushNotifications = pushNotificationsModule as unknown as {
  configure(
    fn: (
      userId: string,
      payload: { title: string; body: string; data?: Record<string, string> }
    ) => Promise<{ sent: number; failed: number; removed: number }>
  ): void;
};

/** Agent push tool: service-role device_tokens lookup + FCM. No confirmation gate. */
pushNotifications.configure(async (userId, payload) => {
  try {
    return await sendPushToUser(userId, payload);
  } catch (err) {
    if (err instanceof HttpError) throw new Error(err.message);
    throw err;
  }
});

/** Agent phone-notification tool: service-role read of this user's rows. No confirmation gate. */
const phoneReader = phoneNotifications as unknown as {
  configure(
    fn: (
      userId: string,
      durationMinutes: number
    ) => Promise<{ items: { appName: string; title: string; text: string; category: string; postedAt: string }[]; truncated: boolean }>
  ): void;
};
phoneReader.configure((userId, durationMinutes) => readPhoneNotifications(userId, durationMinutes));

/**
 * Modules that need the local bot process: the Firefox extension bridge
 * (browser, teams) and the Discord scheduler (local JSON file + DMs).
 * The web scheduler is registered in its place and stores jobs in Supabase.
 */
const LOCAL_ONLY_MODULES = ['browser', 'teams', 'scheduler'];

for (const id of LOCAL_ONLY_MODULES) registry.unregister(id);

interface ActiveSchedule {
  db: SupabaseClient;
  userId: string;
  conversationId: string;
  model: string;
}

let activeScheduling: ActiveSchedule | null = null;

const webScheduler = webSchedulerModule as {
  register(): void;
  bind(api: {
    schedule(input: { runInMinutes?: unknown; runAt?: unknown; cron?: unknown; prompt?: unknown }): Promise<unknown>;
    list(): Promise<unknown>;
    cancel(jobId: string): Promise<boolean>;
  }): void;
};

if (process.env.CURTIS_SURFACE === 'web') {
  webScheduler.register();
  webScheduler.bind({
    schedule(input) {
      if (!activeScheduling) throw new Error('Scheduling is not available in this session.');
      return createScheduledJob(activeScheduling.db, activeScheduling.userId, activeScheduling.conversationId, {
        ...input,
        model: activeScheduling.model,
      });
    },
    list() {
      if (!activeScheduling) throw new Error('Scheduling is not available in this session.');
      return listScheduledJobs(activeScheduling.db, activeScheduling.userId);
    },
    cancel(jobId) {
      if (!activeScheduling) throw new Error('Scheduling is not available in this session.');
      return cancelScheduledJob(activeScheduling.db, activeScheduling.userId, jobId);
    },
  });
}

// There is no Discord channel to purge on the web; "clear the chat" resets agent memory.
const clearContext = registry.getToolHandler('clear_context');
if (clearContext) registry.toolHandlers.set('clear_chat', clearContext);

const MAX_STATE_FILE_BYTES = 512 * 1024;
const PENDING_TTL_MS = Number(process.env.PENDING_ACTION_TTL_MS) || 30 * 60 * 1000;

export interface AgentMessage {
  role: string;
  content: string;
}

export interface StoredPendingAction {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  turnId: string | null;
  createdAt: number;
}

export interface StateFile {
  path: string;
  content: string;
}

export interface AgentSnapshot {
  history: AgentMessage[];
  pending: StoredPendingAction | null;
  files: StateFile[];
}

export interface AgentUser {
  id: string;
  email: string | null;
  displayName: string;
}

export interface TurnResult {
  reply: string;
  history: AgentMessage[];
  pending: StoredPendingAction | null;
  changedFiles: StateFile[];
  removedPaths: string[];
}

function stateDir(): string {
  return process.env.CURTIS_STATE_DIR || '/tmp/curtis';
}

function resolveInside(root: string, relative: string): string {
  const full = path.resolve(root, relative);
  if (!full.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`State file escapes state dir: ${relative}`);
  }
  return full;
}

async function materializeFiles(files: StateFile[]): Promise<void> {
  const root = stateDir();
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  for (const file of files) {
    const full = resolveInside(root, file.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.content, 'utf8');
  }
}

async function collectFiles(dir = stateDir(), prefix = ''): Promise<StateFile[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: StateFile[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full, rel)));
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      if (stat.size > MAX_STATE_FILE_BYTES) {
        console.warn(`[agent-runtime] skipping oversized state file ${rel} (${stat.size} bytes)`);
        continue;
      }
      out.push({ path: rel, content: await fs.readFile(full, 'utf8') });
    }
  }
  return out;
}

function resetMemory(channelId: string, userId: string): void {
  conversationStore.clearSession(channelId, userId);
  pendingActions.clear(channelId, userId);
}

/**
 * Run one agent turn against persisted state.
 *
 * The core keeps history and pending confirmations in module-level Maps and
 * writes memory/release files to disk. Lambda runs one invocation per
 * execution environment at a time, so those stores (and the state dir) are
 * loaded from the snapshot here and wiped again before returning.
 */
export async function runAgentTurn({
  conversationId,
  user,
  text,
  snapshot,
  scheduling = null,
}: {
  conversationId: string;
  user: AgentUser;
  text: string;
  snapshot: AgentSnapshot;
  /** Present on web turns so schedule_task can write the caller's jobs. */
  scheduling?: { db: SupabaseClient; model: string } | null;
}): Promise<TurnResult> {
  const channelId = conversationId;
  const userId = user.id;
  const session = {
    userId,
    username: user.email ?? userId,
    displayName: user.displayName,
    channelId,
    guildId: null,
    channelType: 'web',
  };

  resetMemory(channelId, userId);
  if (scheduling) {
    activeScheduling = { db: scheduling.db, userId, conversationId, model: scheduling.model };
  }
  try {
    for (const msg of snapshot.history) {
      conversationStore.appendMessage(channelId, userId, msg.role, msg.content, session);
    }

    let restoredPending: PendingEntry | null = null;
    const stored = snapshot.pending;
    if (stored && Date.now() - stored.createdAt < PENDING_TTL_MS) {
      restoredPending = pendingActions.set(channelId, userId, {
        tool: stored.tool,
        args: stored.args,
        summary: stored.summary,
        turnId: stored.turnId,
      });
    }

    await materializeFiles(snapshot.files);

    const reply = await discordAgent.handleUserMessage({ text, discord: session });

    const after = pendingActions.get(channelId, userId);
    let pending: StoredPendingAction | null = null;
    if (after && after === restoredPending && stored) {
      pending = stored;
    } else if (after) {
      pending = {
        tool: after.tool,
        args: after.args,
        summary: after.summary,
        turnId: after.turnId,
        createdAt: after.createdAt,
      };
    }

    const before = new Map(snapshot.files.map((f) => [f.path, f.content]));
    const now = await collectFiles();
    const nowPaths = new Set(now.map((f) => f.path));

    return {
      reply: String(reply ?? ''),
      history: conversationStore.getHistory(channelId, userId).map((m) => ({
        role: String(m.role),
        content: String(m.content),
      })),
      pending,
      changedFiles: now.filter((f) => before.get(f.path) !== f.content),
      removedPaths: [...before.keys()].filter((p) => !nowPaths.has(p)),
    };
  } finally {
    activeScheduling = null;
    resetMemory(channelId, userId);
    await fs.rm(stateDir(), { recursive: true, force: true });
  }
}
