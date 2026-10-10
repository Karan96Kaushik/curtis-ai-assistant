import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BEHAVIOR_FILE,
  CONTEXT_INDEX_FILE,
  defaultContextTitle,
  isEphemeralStatePath,
  kindForSlug,
  MAX_REFERENCE_CHARS,
  ORG_MEMORY_FILE,
  ORG_MEMORY_SLUG,
  SLUG_RE,
  slugFromAgentPath,
  type ContextKind,
} from '../../../lib/contexts/slugs.js';
import type { StateFile } from './agentRuntime.js';

export interface ContextRow {
  slug: string;
  title: string;
  kind: ContextKind;
  content: string;
}

interface IndexEntry {
  slug: string;
  title: string;
  kind: 'reference';
}

export function contextsTableMissing(error: { message?: string; code?: string }): boolean {
  const message = error.message ?? '';
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    (/contexts/i.test(message) && /does not exist|schema cache|could not find/i.test(message))
  );
}

export async function loadContexts(
  db: SupabaseClient,
  userId: string
): Promise<{ enabled: boolean; rows: ContextRow[] }> {
  const { data, error } = await db.from('contexts').select('slug, title, kind, content').eq('user_id', userId);
  if (error) {
    if (contextsTableMissing(error)) {
      console.warn('[chat] contexts table is missing. Run supabase/migrations/0002_contexts.sql');
      return { enabled: false, rows: [] };
    }
    throw error;
  }
  const rows = ((data ?? []) as ContextRow[]).filter((row) => SLUG_RE.test(row.slug));
  return { enabled: true, rows };
}

/**
 * Overlay saved contexts onto the agent state snapshot and write the index the
 * model uses to discover them. Behavior is materialized for the prompt only.
 */
export function applyContexts(files: StateFile[], contexts: ContextRow[]): StateFile[] {
  const map = new Map(files.map((file) => [file.path, file.content]));
  const index: IndexEntry[] = [];

  const behaviorSections = contexts
    .filter((ctx) => SLUG_RE.test(ctx.slug) && ctx.kind === 'behavior' && ctx.content.trim())
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((ctx) => `# ${ctx.title || ctx.slug}\n\n${ctx.content.trim()}`);
  if (behaviorSections.length) map.set(BEHAVIOR_FILE, `${behaviorSections.join('\n\n')}\n`);
  else map.delete(BEHAVIOR_FILE);

  for (const ctx of contexts) {
    if (!SLUG_RE.test(ctx.slug)) continue;
    if (ctx.kind === 'behavior') continue;
    const filePath = ctx.slug === ORG_MEMORY_SLUG ? ORG_MEMORY_FILE : `contexts/${ctx.slug}.md`;
    map.set(filePath, ctx.content);
    index.push({ slug: ctx.slug, title: ctx.title || defaultContextTitle(ctx.slug), kind: 'reference' });
  }

  if (map.has(ORG_MEMORY_FILE) && !index.some((entry) => entry.slug === ORG_MEMORY_SLUG)) {
    index.push({ slug: ORG_MEMORY_SLUG, title: 'Org memory', kind: 'reference' });
  }

  map.set(CONTEXT_INDEX_FILE, `${JSON.stringify(index)}\n`);
  return [...map.entries()].map(([path, content]) => ({ path, content }));
}

export function persistableFiles(changed: StateFile[], removed: string[], loaded: StateFile[]): {
  changed: StateFile[];
  removed: string[];
} {
  const staleEphemeral = loaded.filter((file) => isEphemeralStatePath(file.path)).map((file) => file.path);
  return {
    changed: changed.filter((file) => !isEphemeralStatePath(file.path)),
    removed: [...removed.filter((filePath) => !isEphemeralStatePath(filePath)), ...staleEphemeral],
  };
}

/** Copy agent writes of org memory and reference docs back into contexts. Never persists behavior. */
export async function syncContextsFromTurn(
  db: SupabaseClient,
  userId: string,
  existing: ContextRow[],
  changed: StateFile[],
  removed: string[]
): Promise<void> {
  const bySlug = new Map(existing.map((row) => [row.slug, row]));
  const updatedAt = new Date().toISOString();
  const upserts: Array<{
    user_id: string;
    slug: string;
    title: string;
    kind: ContextKind;
    content: string;
    updated_at: string;
  }> = [];

  for (const file of changed) {
    const slug = slugFromAgentPath(file.path);
    if (!slug) continue;
    const prev = bySlug.get(slug);
    upserts.push({
      user_id: userId,
      slug,
      title: prev?.title || defaultContextTitle(slug),
      kind: prev?.kind && slug !== 'behavior' ? prev.kind : kindForSlug(slug),
      content: file.content.slice(0, MAX_REFERENCE_CHARS),
      updated_at: updatedAt,
    });
  }

  if (upserts.length) {
    const { error } = await db.from('contexts').upsert(upserts);
    if (error) throw error;
  }

  const deleteSlugs = [...new Set(removed.map((filePath) => slugFromAgentPath(filePath)).filter((slug): slug is string => !!slug))];
  if (deleteSlugs.length) {
    const { error } = await db.from('contexts').delete().eq('user_id', userId).in('slug', deleteSlugs);
    if (error) throw error;
  }
}

/** So existing org-memory.md in agent_files shows up in Settings before the next memory write. */
export async function backfillOrgMemory(
  db: SupabaseClient,
  userId: string,
  files: StateFile[],
  contexts: ContextRow[]
): Promise<ContextRow[]> {
  if (contexts.some((row) => row.slug === ORG_MEMORY_SLUG)) return contexts;
  const file = files.find((entry) => entry.path === ORG_MEMORY_FILE);
  const content = file?.content ?? '';
  if (!content.trim() || content.length > MAX_REFERENCE_CHARS) return contexts;

  const row: ContextRow = {
    slug: ORG_MEMORY_SLUG,
    title: 'Org memory',
    kind: 'reference',
    content,
  };
  const { error } = await db.from('contexts').upsert({
    user_id: userId,
    ...row,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error('[chat] org memory backfill failed:', error.message);
    return contexts;
  }
  return [...contexts, row];
}
