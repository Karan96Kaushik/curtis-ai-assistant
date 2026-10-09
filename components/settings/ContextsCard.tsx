import { useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { BEHAVIOR_SLUG, MAX_BEHAVIOR_CHARS, maxCharsForSlug, ORG_MEMORY_SLUG, SLUG_RE, slugifyTitle } from '@/lib/contexts/slugs';
import {
  contextsTableMissing,
  deleteContext,
  errorText,
  listContexts,
  upsertContext,
  type ContextRecord,
} from '@/lib/supabase/contexts';

const MIGRATION_HINT = 'Run supabase/migrations/0002_contexts.sql in the Supabase SQL editor, then reload.';

function rank(row: ContextRecord): number {
  if (row.kind === 'behavior' || row.slug === BEHAVIOR_SLUG) return 0;
  if (row.slug === ORG_MEMORY_SLUG) return 1;
  return 2;
}

interface EditorState {
  mode: 'create' | 'edit';
  slug: string;
  title: string;
  content: string;
  slugTouched: boolean;
}

export default function ContextsCard() {
  const [rows, setRows] = useState<ContextRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ContextRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function reload() {
    try {
      const list = await listContexts();
      setRows([...list].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)));
      setLoadError(null);
    } catch (err) {
      setRows([]);
      setLoadError(contextsTableMissing(err) ? MIGRATION_HINT : errorText(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function openCreate() {
    setEditor({ mode: 'create', slug: '', title: '', content: '', slugTouched: false });
  }

  function openEdit(row: ContextRecord) {
    setEditor({ mode: 'edit', slug: row.slug, title: row.title, content: row.content, slugTouched: true });
  }

  async function save() {
    if (!editor) return;
    setSaving(true);
    try {
      await upsertContext({ slug: editor.slug, title: editor.title, content: editor.content });
      toast.success(editor.slug === BEHAVIOR_SLUG ? 'Behavior saved. Future chats will follow it.' : 'Context saved.');
      setEditor(null);
      await reload();
    } catch (err) {
      toast.error(contextsTableMissing(err) ? MIGRATION_HINT : errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteContext(pendingDelete.slug);
      toast.success(pendingDelete.slug === BEHAVIOR_SLUG ? 'Behavior cleared.' : 'Context deleted.');
      setPendingDelete(null);
      await reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setDeleting(false);
    }
  }

  const slug = editor?.slug.trim() ?? '';
  const slugOk = SLUG_RE.test(slug);
  const limit = slugOk ? maxCharsForSlug(slug) : MAX_BEHAVIOR_CHARS;
  const canSave = !!editor && slugOk && editor.title.trim().length > 0 && editor.title.trim().length <= 120 && editor.content.length <= limit;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Contexts</CardTitle>
            <CardDescription>
              Documents Curtis can read, such as org memory and specs. Behavior is applied to later chats only after you
              approve it.
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={openCreate} disabled={!!loadError}>
            <Plus />
            Add
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {rows === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading contexts…
          </div>
        ) : loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing stored yet. Add org memory or a spec here, or use Save behavior in a chat.
          </p>
        ) : (
          rows.map((row) => (
            <div key={row.slug} className="flex items-start gap-3 rounded-lg border px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{row.title}</p>
                  <Badge variant="outline">{row.kind === 'behavior' ? 'Behavior' : row.slug}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {row.content.trim() || 'Empty'}
                </p>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Edit ${row.title}`} onClick={() => openEdit(row)}>
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${row.title}`}
                onClick={() => setPendingDelete(row)}
              >
                <Trash2 />
              </Button>
            </div>
          ))
        )}
      </CardContent>

      <Dialog open={!!editor} onOpenChange={(open) => !open && !saving && setEditor(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editor?.mode === 'edit' ? 'Edit context' : 'Add context'}</DialogTitle>
            <DialogDescription>
              {slug === BEHAVIOR_SLUG
                ? 'This document changes how Curtis responds in later chats.'
                : slug === ORG_MEMORY_SLUG
                  ? 'Org memory is included in every chat. Curtis can also append facts when you ask it to remember something.'
                  : 'Curtis can read this when a task needs it. A slug like timesheet-filing-spec keeps the name stable.'}
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="context-title">Title</Label>
                <Input
                  id="context-title"
                  value={editor.title}
                  onChange={(event) => {
                    const title = event.target.value;
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            title,
                            slug: current.mode === 'create' && !current.slugTouched ? slugifyTitle(title) : current.slug,
                          }
                        : current
                    );
                  }}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="context-slug">Slug</Label>
                <Input
                  id="context-slug"
                  value={editor.slug}
                  disabled={editor.mode === 'edit'}
                  onChange={(event) =>
                    setEditor((current) => (current ? { ...current, slug: event.target.value, slugTouched: true } : current))
                  }
                  placeholder="org-memory"
                  aria-invalid={editor.slug.length > 0 && !slugOk}
                />
                {editor.slug.length > 0 && !slugOk && (
                  <p className="text-xs text-destructive">Lowercase letters, numbers, and hyphens only.</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="context-content">Content</Label>
                <Textarea
                  id="context-content"
                  value={editor.content}
                  onChange={(event) => setEditor((current) => (current ? { ...current, content: event.target.value } : current))}
                  className="max-h-80 min-h-48 overflow-y-auto font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  {editor.content.length.toLocaleString()} / {limit.toLocaleString()} characters
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditor(null)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void save()} disabled={!canSave || saving}>
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingDelete} onOpenChange={(open) => !open && !deleting && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {pendingDelete?.title}?</DialogTitle>
            <DialogDescription>
              {pendingDelete?.slug === BEHAVIOR_SLUG
                ? 'Future chats will stop following this behavior.'
                : 'Curtis will no longer be able to read this document.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Loader2 className="animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
