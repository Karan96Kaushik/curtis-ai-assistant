/**
 * Drives the chat Lambda's agent runtime locally (no Supabase, no AWS):
 * three turns where state only survives through the returned snapshot, the
 * same way the handler round-trips it through Postgres.
 *
 *   npm run test:agent-runtime
 *
 * Needs GROQ_API_KEY (and Jira env for the staging turn) in .env. Turn 2 only
 * stages a Jira create behind the confirmation gate; turn 3 cancels it.
 */
import os from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';

config();

const stateDir = path.join(os.tmpdir(), 'curtis-agent-runtime-test');
process.env.CURTIS_STATE_DIR = stateDir;
process.env.ORG_MEMORY_PATH = path.join(stateDir, 'org-memory.md');
process.env.BEHAVIOR_MEMORY_PATH = path.join(stateDir, 'behavior.md');
process.env.WF_RELEASE_DIR = path.join(stateDir, 'releases');
process.env.REQUIRE_CONFIRMATION = '1';
process.env.CURTIS_SURFACE = 'web';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

async function main() {
  const { runAgentTurn } = await import('../amplify/functions/chat/agentRuntime.js');
  type Snapshot = Parameters<typeof runAgentTurn>[0]['snapshot'];

  const conversationId = '00000000-0000-4000-8000-000000000001';
  const user = { id: 'local-test-user', email: 'local@test', displayName: 'Local' };
  let snapshot: Snapshot = { history: [], pending: null, files: [] };

  async function turn(text: string) {
    console.log(`\n> ${text}`);
    const result = await runAgentTurn({ conversationId, user, text, snapshot });
    console.log(result.reply);
    const kept = new Map(snapshot.files.map((f) => [f.path, f]));
    for (const p of result.removedPaths) kept.delete(p);
    for (const f of result.changedFiles) kept.set(f.path, f);
    snapshot = { history: result.history, pending: result.pending, files: [...kept.values()] };
    return result;
  }

  const first = await turn('What can you do?');
  assert(first.reply.length > 0, 'capability answer is non-empty');
  assert(first.history.length === 2, 'history holds the user + assistant messages');

  const staged = await turn('Create a Jira task in project AATP titled "agent runtime smoke test — do not create"');
  assert(staged.pending?.tool === 'jira_create', 'jira_create is staged, not executed');
  assert(staged.history.length === 4, 'history carried over from turn 1');

  const cancelled = await turn('cancel');
  assert(cancelled.pending === null, 'cancel clears the persisted pending action');
  assert(/cancel/i.test(cancelled.reply), 'reply confirms the cancellation');

  console.log('\nAll agent runtime checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
