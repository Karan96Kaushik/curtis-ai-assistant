import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { answerAgentRun, cancelAgentRun, decideAgentApproval, retryAgentRun } from '@/lib/amplify/agent-functions';
import { getAgentRun, listAgentEvents, pendingRequest, snapshotLimit, snapshotName } from '@/lib/supabase/agentRuns';
import type { AgentEventRow, AgentRunRow, AgentRunStatus, Json } from '@/lib/supabase/types';
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

function payloadText(payload: Json, key: string): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const value = payload[key];
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function EventRow({ event }: { event: AgentEventRow }) {
  if (event.type === 'thought') {
    return (
      <details className="rounded-md border px-3 py-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Thought</summary>
        <p className="mt-2 whitespace-pre-wrap">{payloadText(event.payload, 'text')}</p>
      </details>
    );
  }
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const name = payloadText(event.payload, 'name') || 'tool';
    const detail = event.type === 'tool_result' ? payloadText(event.payload, 'preview') : payloadText(event.payload, 'args');
    return (
      <details className="rounded-md border px-3 py-2 text-sm">
        <summary className="cursor-pointer">
          {event.type === 'tool_call' ? 'Called' : 'Result'} {name}
        </summary>
        {detail && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{detail}</p>}
      </details>
    );
  }
  if (event.type === 'tool_blocked') {
    return <p className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">Blocked {payloadText(event.payload, 'name')}</p>;
  }
  if (event.type === 'question') {
    return <p className="rounded-md bg-muted px-3 py-2 text-sm">{payloadText(event.payload, 'question')}</p>;
  }
  if (event.type === 'answer') {
    return <p className="ml-8 rounded-md border px-3 py-2 text-sm">{payloadText(event.payload, 'text')}</p>;
  }
  if (event.type === 'approval_request') {
    return (
      <p className="rounded-md border px-3 py-2 text-sm">
        Approval requested for {payloadText(event.payload, 'tool')}. {payloadText(event.payload, 'reason')}
      </p>
    );
  }
  if (event.type === 'approval') {
    return (
      <p className="text-sm text-muted-foreground">
        {payloadText(event.payload, 'decision') === 'approve' ? 'Approved' : 'Denied'} {payloadText(event.payload, 'tool')}
      </p>
    );
  }
  if (event.type === 'finished') return null;
  if (event.type === 'failed') return <p className="text-sm text-destructive">{payloadText(event.payload, 'error')}</p>;
  if (event.type === 'rate_limited') return <p className="text-sm text-muted-foreground">Rate limited. The run will resume.</p>;
  if (event.type === 'provider_fallback') {
    return (
      <p className="text-xs text-muted-foreground">
        Switched provider from {payloadText(event.payload, 'from')} to {payloadText(event.payload, 'to')}
      </p>
    );
  }
  if (event.type === 'summary') return <p className="text-xs text-muted-foreground">Compressed earlier steps.</p>;
  if (event.type === 'started') return <p className="text-xs text-muted-foreground">Started</p>;
  if (event.type === 'cancelled') return <p className="text-sm text-muted-foreground">Cancelled</p>;
  return null;
}

export default function RunDetailView() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<AgentRunRow | null>(null);
  const [events, setEvents] = useState<AgentEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [argsText, setArgsText] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!runId) return;
    const [nextRun, nextEvents] = await Promise.all([getAgentRun(runId), listAgentEvents(runId)]);
    setRun(nextRun);
    setEvents(nextEvents);
    setMissing(!nextRun);
  }, [runId]);

  useEffect(() => {
    let active = true;
    refresh()
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!runId) return;
    const channel = supabase
      .channel(`agent-run-${runId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_runs', filter: `id=eq.${runId}` }, () => {
        refresh().catch(() => undefined);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'agent_events', filter: `run_id=eq.${runId}` }, () => {
        refresh().catch(() => undefined);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh, runId]);

  const pending = run ? pendingRequest(run.pending_request) : null;
  const approvalKey = pending?.kind === 'approval' ? `${pending.tool}:${JSON.stringify(pending.args)}` : '';

  useEffect(() => {
    if (!approvalKey) return;
    const raw = approvalKey.slice(approvalKey.indexOf(':') + 1);
    try {
      setArgsText(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      setArgsText(raw);
    }
  }, [approvalKey]);

  async function sendAnswer(text: string) {
    if (!run) return;
    setBusy(true);
    try {
      await answerAgentRun(run.id, text);
      setReply('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!run) return;
    let edited: unknown;
    if (decision === 'approve' && argsText.trim()) {
      try {
        edited = JSON.parse(argsText) as unknown;
      } catch {
        toast.error('Arguments must be JSON.');
        return;
      }
    }
    setBusy(true);
    try {
      await decideAgentApproval(run.id, decision, decision === 'approve' ? edited : undefined, note);
      setNote('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!run) return;
    setBusy(true);
    try {
      await cancelAgentRun(run.id);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!run) return;
    setBusy(true);
    try {
      const next = await retryAgentRun(run.id);
      navigate(`/agents/runs/${next.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading run…</p>;
  if (missing || !run) {
    return (
      <div className="p-6">
        <p className="text-sm">That run is not available.</p>
        <Button asChild variant="link" className="px-0">
          <Link to="/agents">Back to agents</Link>
        </Button>
      </div>
    );
  }

  const maxSteps = snapshotLimit(run.profile_snapshot, 'max_steps');
  const budget = snapshotLimit(run.profile_snapshot, 'token_budget');
  const open = run.status === 'queued' || run.status === 'running' || run.status === 'waiting_input' || run.status === 'waiting_approval';

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto px-4 py-6">
      <Button asChild variant="link" className="w-fit px-0">
        <Link to="/agents">Agents</Link>
      </Button>
      <div className="flex flex-wrap items-start gap-2">
        <h1 className="min-w-0 flex-1 text-lg font-semibold whitespace-pre-wrap">{run.command}</h1>
        {open && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="outline">{statusLabel(run.status)}</Badge>
        <span>{snapshotName(run.profile_snapshot)}</span>
        <span>
          step {run.step_count}
          {maxSteps ? ` / ${maxSteps}` : ''}
        </span>
        <span>
          {run.tokens_used} tokens{budget ? ` / ${budget}` : ''}
        </span>
      </div>

      {run.status === 'failed' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Failed</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">{run.error}</p>
            <Button size="sm" className="w-fit" disabled={busy} onClick={() => void retry()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {run.status === 'done' && run.result_summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Result</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{run.result_summary}</p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </div>

      {pending?.kind === 'question' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{pending.question}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pending.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {pending.options.map((option) => (
                  <Button key={option} variant="outline" size="sm" disabled={busy} onClick={() => void sendAnswer(option)}>
                    {option}
                  </Button>
                ))}
              </div>
            )}
            <Textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Your answer" />
            <Button className="w-fit" disabled={busy || !reply.trim()} onClick={() => void sendAnswer(reply)}>
              Send
            </Button>
          </CardContent>
        </Card>
      )}

      {pending?.kind === 'approval' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approve {pending.tool}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{pending.reason}</p>
            <Textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} className="font-mono text-xs" />
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note if you deny" />
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void decide('approve')}>
                Approve
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void decide('deny')}>
                Deny
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
