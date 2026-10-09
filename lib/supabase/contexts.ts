import {
  agentFileForSlug,
  BEHAVIOR_SLUG,
  kindForSlug,
  maxCharsForSlug,
  SLUG_RE,
  type ContextKind,
} from '@/lib/contexts/slugs';
import { redactSecrets } from '@/lib/contexts/redact';
import { supabase } from '@/utils/supabase';

export interface ContextRecord {
  slug: string;
  title: string;
  kind: ContextKind;
  content: string;
  updated_at: string;
}

export interface ContextInput {
  slug: string;
  title: string;
  content: string;
}

export function contextsTableMissing(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { message?: string; code?: string };
  const message = record.message ?? '';
  return (
    record.code === '42P01' ||
    record.code === 'PGRST205' ||
    (/contexts/i.test(message) && /does not exist|schema cache|could not find/i.test(message))
  );
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message;
  return String(err);
}

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error('Your session has expired. Sign in again.');
  return userId;
}

export async function listContexts(): Promise<ContextRecord[]> {
  const { data, error } = await supabase
    .from('contexts')
    .select('slug, title, kind, content, updated_at')
    .order('title', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ContextRecord[];
}

export async function upsertContext(input: ContextInput): Promise<void> {
  const slug = input.slug.trim();
  if (!SLUG_RE.test(slug)) {
    throw new Error('Use a slug of lowercase letters, numbers, and hyphens (max 64 characters).');
  }
  const title = input.title.trim();
  if (!title || title.length > 120) throw new Error('Title must be 1–120 characters.');
  const content = redactSecrets(input.content);
  const max = maxCharsForSlug(slug);
  if (content.length > max) throw new Error(`This document is too long (max ${max.toLocaleString()} characters).`);

  const userId = await requireUserId();
  const { error } = await supabase.from('contexts').upsert({
    user_id: userId,
    slug,
    title,
    kind: kindForSlug(slug),
    content,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function deleteContext(slug: string): Promise<void> {
  const { error } = await supabase.from('contexts').delete().eq('slug', slug);
  if (error) throw error;
  const filePath = agentFileForSlug(slug);
  if (!filePath) return;
  const { error: fileError } = await supabase.from('agent_files').delete().eq('path', filePath);
  if (fileError) throw fileError;
}

export async function saveBehavior(content: string): Promise<void> {
  const text = redactSecrets(content).trim();
  if (!text) {
    await deleteContext(BEHAVIOR_SLUG);
    return;
  }
  await upsertContext({ slug: BEHAVIOR_SLUG, title: 'Behavior', content: text });
}
