import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CalendarClock, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUkTime } from '@/lib/schedules/format';
import { cancelScheduledJob, listScheduledJobRuns, listScheduledJobs } from '@/lib/supabase/schedules';
import type { ScheduledJobRow, ScheduledJobRunRow, ScheduledJobStatus } from '@/lib/supabase/types';

const ACTIVE: ScheduledJobStatus[] = ['pending', 'running'];

function statusVariant(status: ScheduledJobStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'running') return 'default';
  if (status === 'pending') return 'secondary';
  if (status === 'failed') return 'destructive';
  return 'outline';
}

function statusLabel(status: ScheduledJobStatus): string {
  if (status === 'pending') return 'Pending';
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  return 'Cancelled';
}

function JobCard({
  job,
  runs,
  cancelling,
  onCancel,
}: {
  job: ScheduledJobRow;
  runs: ScheduledJobRunRow[];
  cancelling: boolean;
  onCancel: (id: string) => void;
}) {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(job.status)}>{statusLabel(job.status)}</Badge>
          {job.cron ? <Badge variant="outline">Recurring · {job.cron}</Badge> : <Badge variant="outline">One-off</Badge>}
        </div>
        <CardTitle className="text-base leading-snug font-medium whitespace-pre-wrap">{job.prompt}</CardTitle>
        <CardDescription>
          {job.status === 'pending' || job.status === 'running' ? 'Next run' : 'Scheduled for'} {formatUkTime(job.run_at)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {job.last_error && <p className="text-sm text-destructive">{job.last_error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/c/${job.conversation_id}`}>Open chat</Link>
          </Button>
          {job.status === 'pending' && (
            <Button variant="ghost" size="sm" disabled={cancelling} onClick={() => onCancel(job.id)}>
              {cancelling ? <Loader2 className="animate-spin" /> : null}
              Cancel
            </Button>
          )}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Runs ({runs.length})</summary>
          {runs.length === 0 ? (
            <p className="mt-2 text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {runs.map((run) => (
                <li key={run.id} className="rounded-md border px-3 py-2">
                  <p className="font-medium">
                    {run.status === 'succeeded' ? 'Succeeded' : run.status === 'failed' ? 'Failed' : 'Running'}
                    <span className="ml-2 font-normal text-muted-foreground">{formatUkTime(run.started_at)}</span>
                  </p>
                  {run.error && <p className="mt-1 text-destructive">{run.error}</p>}
                  {run.reply && <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-muted-foreground">{run.reply}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Push sent {run.push_sent}
                    {run.push_failed > 0 ? `, failed ${run.push_failed}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </details>
      </CardContent>
    </Card>
  );
}

export default function SchedulesView() {
  const [jobs, setJobs] = useState<ScheduledJobRow[]>([]);
  const [runs, setRuns] = useState<ScheduledJobRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = useCallback(async (mode: 'initial' | 'refresh' | 'poll') => {
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    try {
      const [nextJobs, nextRuns] = await Promise.all([listScheduledJobs(), listScheduledJobRuns()]);
      setJobs(nextJobs);
      setRuns(nextRuns);
    } catch (err) {
      if (mode !== 'poll') toast.error(err instanceof Error ? err.message : 'Could not load schedules');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    document.title = 'Schedules · Curtis';
    void load('initial');
    const timer = window.setInterval(() => void load('poll'), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const runsByJob = useMemo(() => {
    const grouped = new Map<string, ScheduledJobRunRow[]>();
    for (const run of runs) {
      const list = grouped.get(run.job_id) ?? [];
      list.push(run);
      grouped.set(run.job_id, list);
    }
    return grouped;
  }, [runs]);

  const upcoming = jobs
    .filter((job) => ACTIVE.includes(job.status))
    .sort((a, b) => a.run_at.localeCompare(b.run_at));
  const recent = jobs.filter((job) => !ACTIVE.includes(job.status));

  async function handleCancel(id: string) {
    setCancellingId(id);
    try {
      const cancelled = await cancelScheduledJob(id);
      if (!cancelled) toast.error('That schedule is no longer pending.');
      else toast.success('Schedule cancelled.');
      await load('refresh');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel the schedule');
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 md:px-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Schedules</h1>
            <p className="text-sm text-muted-foreground">
              Tasks Curtis will run later. Results are posted in the chat and pushed to your phone. Times are UK local.
            </p>
          </div>
          <Button variant="outline" size="icon" aria-label="Refresh schedules" disabled={refreshing} onClick={() => void load('refresh')}>
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading schedules…</p>
        ) : jobs.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="size-4" />
                Nothing scheduled
              </CardTitle>
              <CardDescription>Ask Curtis in a chat to run something later, once or on a cron.</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">Upcoming</h2>
              {upcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground">No pending schedules.</p>
              ) : (
                upcoming.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    runs={runsByJob.get(job.id) ?? []}
                    cancelling={cancellingId === job.id}
                    onCancel={(id) => void handleCancel(id)}
                  />
                ))
              )}
            </section>
            {recent.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-muted-foreground">Recent</h2>
                {recent.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    runs={runsByJob.get(job.id) ?? []}
                    cancelling={false}
                    onCancel={(id) => void handleCancel(id)}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
