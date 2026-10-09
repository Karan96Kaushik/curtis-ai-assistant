export const BEHAVIOR_SLUG = 'behavior';
export const ORG_MEMORY_SLUG = 'org-memory';
export const BEHAVIOR_FILE = 'behavior.md';
export const ORG_MEMORY_FILE = 'org-memory.md';
export const CONTEXT_INDEX_FILE = 'contexts/index.json';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_REFERENCE_CHARS = 100_000;
export const MAX_BEHAVIOR_CHARS = 12_000;

export type ContextKind = 'reference' | 'behavior';

export function isEphemeralStatePath(filePath: string): boolean {
  return filePath === BEHAVIOR_FILE || filePath === CONTEXT_INDEX_FILE;
}

export function defaultContextTitle(slug: string): string {
  if (slug === ORG_MEMORY_SLUG) return 'Org memory';
  if (slug === BEHAVIOR_SLUG) return 'Behavior';
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function kindForSlug(slug: string): ContextKind {
  return slug === BEHAVIOR_SLUG ? 'behavior' : 'reference';
}

export function maxCharsForKind(kind: ContextKind): number {
  return kind === 'behavior' ? MAX_BEHAVIOR_CHARS : MAX_REFERENCE_CHARS;
}

export function maxCharsForSlug(slug: string): number {
  return maxCharsForKind(kindForSlug(slug));
}

/** Slug from a title that does not collide with a slug already in use. */
export function uniqueSlug(title: string, taken: ReadonlySet<string>): string {
  let base = slugifyTitle(title);
  if (!SLUG_RE.test(base)) base = 'behavior';
  if (base === ORG_MEMORY_SLUG) base = 'behavior-notes';
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    const suffix = `-${n}`;
    slug = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    n += 1;
  }
  return slug;
}

/** Agent-written files that should be copied into the contexts table. Behavior is excluded. */
export function slugFromAgentPath(filePath: string): string | null {
  if (isEphemeralStatePath(filePath)) return null;
  if (filePath === ORG_MEMORY_FILE) return ORG_MEMORY_SLUG;
  const match = /^contexts\/([a-z0-9][a-z0-9-]{0,63})\.md$/.exec(filePath);
  if (!match || match[1] === BEHAVIOR_SLUG) return null;
  return match[1];
}

export function agentPathForContext(slug: string, kind: ContextKind): string | null {
  if (!SLUG_RE.test(slug)) return null;
  if (kind === 'behavior' || slug === BEHAVIOR_SLUG) return BEHAVIOR_FILE;
  if (slug === ORG_MEMORY_SLUG) return ORG_MEMORY_FILE;
  return `contexts/${slug}.md`;
}

/** agent_files path to drop when a context row is deleted, so the next turn cannot restore it. */
export function agentFileForSlug(slug: string): string | null {
  return agentPathForContext(slug, kindForSlug(slug));
}
