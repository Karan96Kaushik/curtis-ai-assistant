import { redactSecrets } from './redact.js';
import { MAX_BEHAVIOR_CHARS, SLUG_RE, uniqueSlug, type ContextKind } from './slugs.js';

export interface BehaviorContextRef {
  slug: string;
  title: string;
  kind: ContextKind;
  content: string;
}

export interface BehaviorProposalFields {
  action: 'create' | 'update';
  slug: string;
  title: string;
  summary: string;
  content: string;
  previous: string;
}

function cleanTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Turn the model's JSON into one behavior row. A matching title or slug updates
 * that context. Anything else becomes a new row whose slug does not collide.
 */
export function resolveBehaviorProposal(
  parsed: { action?: unknown; slug?: unknown; title?: unknown; summary?: unknown; content?: unknown },
  existing: readonly BehaviorContextRef[]
): BehaviorProposalFields {
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 600) : '';
  if (!summary) throw new Error('The model did not explain the behavior proposal');

  const behaviors = existing.filter((row) => row.kind === 'behavior');
  const requestedSlug = typeof parsed.slug === 'string' ? parsed.slug.trim() : '';
  const requestedTitle = cleanTitle(parsed.title);
  const bySlug = behaviors.find((row) => row.slug === requestedSlug);
  const byTitle = behaviors.find((row) => requestedTitle && sameTitle(row.title, requestedTitle));
  const wantsUpdate = parsed.action === 'update' || !!bySlug || !!byTitle;
  const target = bySlug || byTitle;

  const rawContent = typeof parsed.content === 'string' ? parsed.content : '';
  const content = redactSecrets(rawContent).trim().slice(0, MAX_BEHAVIOR_CHARS);

  if (wantsUpdate && target) {
    const title = requestedTitle || target.title;
    return {
      action: 'update',
      slug: target.slug,
      title,
      summary,
      content,
      previous: target.content,
    };
  }

  const title = requestedTitle || 'Behavior';
  const taken = new Set(existing.map((row) => row.slug));
  let slug = SLUG_RE.test(requestedSlug) && !taken.has(requestedSlug) ? requestedSlug : uniqueSlug(title, taken);
  if (taken.has(slug)) slug = uniqueSlug(title, taken);
  return {
    action: 'create',
    slug,
    title,
    summary,
    content,
    previous: '',
  };
}
