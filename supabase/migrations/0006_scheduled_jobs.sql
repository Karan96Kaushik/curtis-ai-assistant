-- Scheduled agent prompts and the log of each run.
-- The chat Lambda inserts jobs under the caller's JWT. A once-a-minute tick
-- claims due rows and invokes runScheduledJob, which writes runs with the
-- service role (it has no user session when the clock fires).

create table public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  prompt text not null check (char_length(prompt) between 1 and 4000),
  run_at timestamptz not null,
  cron text check (cron is null or char_length(cron) between 1 and 120),
  timezone text not null default 'Europe/London' check (timezone = 'Europe/London'),
  model text check (model is null or char_length(model) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  last_error text check (last_error is null or char_length(last_error) <= 2000),
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index scheduled_jobs_user_updated_idx
  on public.scheduled_jobs (user_id, updated_at desc);

create index scheduled_jobs_due_idx
  on public.scheduled_jobs (run_at)
  where status = 'pending';

create table public.scheduled_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.scheduled_jobs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  reply text check (reply is null or char_length(reply) <= 20000),
  error text check (error is null or char_length(error) <= 2000),
  push_sent integer not null default 0 check (push_sent >= 0),
  push_failed integer not null default 0 check (push_failed >= 0)
);

create index scheduled_job_runs_job_started_idx
  on public.scheduled_job_runs (job_id, started_at desc);

create index scheduled_job_runs_user_started_idx
  on public.scheduled_job_runs (user_id, started_at desc);

alter table public.scheduled_jobs enable row level security;
alter table public.scheduled_job_runs enable row level security;

grant select, insert, update on public.scheduled_jobs to authenticated;
grant select on public.scheduled_job_runs to authenticated;

create policy scheduled_jobs_owner_select on public.scheduled_jobs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy scheduled_jobs_owner_insert on public.scheduled_jobs
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and locked_at is null
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );

create policy scheduled_jobs_owner_update on public.scheduled_jobs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy scheduled_job_runs_owner_select on public.scheduled_job_runs
  for select to authenticated
  using (user_id = (select auth.uid()));

-- So an open chat can show a reply that a scheduled run inserted.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
