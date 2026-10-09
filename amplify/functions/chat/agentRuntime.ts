import fs from 'node:fs/promises';
import path from 'node:path';
import discordAgent from '../../../src/ai/discordAgent.js';
import conversationStoreModule from '../../../src/ai/conversationStore.js';
import pendingActionsModule from '../../../src/ai/pendingActions.js';
import registry from '../../../src/core/moduleRegistry.js';
import phoneNotifications from '../../../src/ai/phoneNotifications.js';

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

/**
 * Modules that need the local bot process: the Firefox extension bridge
 * (browser, teams) and the 30s cron loop that posts to Discord (scheduler).
 */
const LOCAL_ONLY_MODULES = ['browser', 'teams', 'scheduler'];

for (const id of LOCAL_ONLY_MODULES) registry.unregister(id);

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
const phone = phoneNotifications as unknown as {
  setTurnContext(context: unknown): void;
  clearTurnContext(): void;
};

export async function runAgentTurn({
  conversationId,
  user,
  text,
  snapshot,
  phoneNotifications: phoneContext = null,
}: {
  conversationId: string;
  user: AgentUser;
  text: string;
  snapshot: AgentSnapshot;
  /** Sanitized notification window for this turn. Null unless the user just confirmed a share. */
  phoneNotifications?: unknown;
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
  phone.setTurnContext(phoneContext);
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
    phone.clearTurnContext();
    resetMemory(channelId, userId);
    await fs.rm(stateDir(), { recursive: true, force: true });
  }
}
