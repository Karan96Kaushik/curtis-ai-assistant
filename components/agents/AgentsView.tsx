import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bot, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { agentApiConfigured } from '@/lib/amplify/client';
import { createAgentRun } from '@/lib/amplify/agent-functions';
import { listAgentProfiles, listAgentRuns, snapshotName } from '@/lib/supabase/agentRuns';
import type { AgentProfileRow, AgentRunRow, AgentRunStatus } from '@/lib/supabase/types';
import { supabase } from '@/utils/supabase';

function statusLabel(status: AgentRunStatus): string {
  if (status === 'waiting_input') return 'Needs an answer';
  if (status === 'waiting_approval') return 'Needs approval';
  if (status === 'queued') return 'Queued';
  if (status === 'running') return 'Running';
  if (status === 'done') return 'Done';
  if (status === 'failed') return 'Failed';
  return 'Cancelled';
}

function statusVariant(status: AgentRunStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'waiting_input' || status === 'waiting_approval') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'running' || status === 'queued') return 'secondary';
  return 'outline';
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function RunRow({ run }: { run: AgentRunRow }) {
  return (
    <Link to={`/agents/runs/${run.id}`} className="block rounded-md border px-3 py-3 transition-colors hover:bg-accent">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(run.status)}>{statusLabel(run.status)}</Badge>
        <span className="text-xs text-muted-foreground">{snapshotName(run.profile_snapshot)}</span>
        <span className="text-xs text-muted-foreground">step {run.step_count}</span>
        <span className="ml-auto text-xs text-muted-foreground">{relativeTime(run.updated_at)}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm">{run.command}</p>
    </Link>
  );
}

function Section({ title, runs }: { title: string; runs: AgentRunRow[] }) {
  if (!runs.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </section>
  );
}

export default function AgentsView() {
  const navigate = useNavigate();
  const [command, setCommand] = useState('');
  const [profileId, setProfileId] = useState('');
  const [profiles, setProfiles] = useState<AgentProfileRow[]>([]);
  const [runs, setRuns] = useState<AgentRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const [nextRuns, nextProfiles] = await Promise.all([listAgentRuns(), listAgentProfiles()]);
    setRuns(nextRuns);
    setProfiles(nextProfiles);
  }, []);

  useEffect(() => {
    let active = true;
    refresh()
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    const channel = supabase
      .channel('agent-runs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_runs' }, () => {
        refresh().catch(() => undefined);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  const selected = profiles.find((profile) => profile.id === profileId) ?? null;

  async function launch() {
    const text = command.trim();
    if (!text) return;
    setLaunching(true);
    try {
      const run = await createAgentRun(text, profileId || undefined);
      setCommand('');
      navigate(`/agents/runs/${run.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }

  const needs = runs.filter((run) => run.status === 'waiting_input' || run.status === 'waiting_approval');
  const active = runs.filter((run) => run.status === 'queued' || run.status === 'running');
  const recent = runs.filter((run) => run.status === 'done' || run.status === 'failed' || run.status === 'cancelled');

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto px-4 py-6">
      <div className="flex items-center gap-2">
        <Bot className="size-5" />
        <h1 className="text-lg font-semibold">Agents</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New run</CardTitle>
          <CardDescription>Give the agent a goal. It works in steps and pauses when it needs you.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!agentApiConfigured && (
            <p className="text-sm text-destructive">
              The agent API is not in amplify_outputs.json yet. Run the Amplify sandbox after applying the agent migration.
            </p>
          )}
          <Textarea
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Read my recent email and tell me what needs a reply."
            maxLength={4000}
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Profile</span>
            <select
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
            >
              <option value="">Inbox (default)</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-1">
            {(selected?.allowed_tools ?? ['email.list', 'email.get']).map((tool) => (
              <Badge key={tool} variant="outline">
                {tool}
                {selected?.approval_required.includes(tool) ? ' · approval' : ''}
              </Badge>
            ))}
            <Badge variant="secondary">ask_user</Badge>
            <Badge variant="secondary">finish</Badge>
          </div>
          <Button onClick={() => void launch()} disabled={launching || !command.trim() || !agentApiConfigured}>
            {launching ? <Loader2 className="animate-spin" /> : null}
            Start agent
          </Button>
        </CardContent>
      </Card>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading runs…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <div className="flex flex-col gap-6">
          <Section title="Needs you" runs={needs} />
          <Section title="Running" runs={active} />
          <Section title="Recent" runs={recent} />
        </div>
      )}
    </div>
  );
}
