-- Full schema for the Curtis web app. Source of truth; supabase/migrations holds
-- the incremental history. Every table is owned by auth.uid() under RLS.

-- One chat thread. agent_history / pending_action are the agent's working
-- state (what discordAgent keeps in memory), persisted between Lambda turns.
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'New chat' check (char_length(title) between 1 and 200),
  agent_history jsonb not null default '[]'::jsonb,
  pending_action jsonb,
  -- Set to the in-flight turn id when the user stops a request.
  cancel_turn_id text check (cancel_turn_id is null or char_length(cancel_turn_id) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

-- Display transcript shown in the UI.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'error')),
  content text not null,
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

-- Files the agent writes under its state dir (org memory, release workflows),
-- restored into /tmp before each turn and saved back afterwards.
create table public.agent_files (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path text not null check (path !~ '^/' and path !~ '\.\.'),
  content text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.agent_files enable row level security;

grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
grant select, insert, update, delete on public.agent_files to authenticated;

create policy conversations_owner on public.conversations
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy messages_owner_select on public.messages
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy messages_owner_insert on public.messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );

create policy messages_owner_delete on public.messages
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy agent_files_owner on public.agent_files
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Named documents (org memory, specs) plus behavior contexts. A user may have
-- several behavior rows. Later chats follow them only after the user approves.
create table public.contexts (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null check (char_length(title) between 1 and 120),
  kind text not null check (kind in ('reference', 'behavior')),
  content text not null default '' check (char_length(content) <= 100000),
  updated_at timestamptz not null default now(),
  primary key (user_id, slug)
);

alter table public.contexts enable row level security;

grant select, insert, update, delete on public.contexts to authenticated;

create policy contexts_owner on public.contexts
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- FCM registration tokens. The Android app upserts after Firebase + Supabase sign-in.
-- Outbound push (Amplify sendPush) reads these under the caller's JWT / RLS.
create table public.device_tokens (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token text not null check (char_length(token) between 32 and 4096),
  platform text not null default 'android' check (platform in ('android', 'ios', 'web')),
  device_id text check (device_id is null or char_length(device_id) between 1 and 200),
  updated_at timestamptz not null default now(),
  primary key (user_id, token)
);

create index device_tokens_user_updated_idx
  on public.device_tokens (user_id, updated_at desc);

alter table public.device_tokens enable row level security;

grant select, insert, update, delete on public.device_tokens to authenticated;

create policy device_tokens_owner on public.device_tokens
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Scheduled agent prompts. Runs are written by the service role when the tick fires.
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
grant all on public.scheduled_jobs to service_role;
grant all on public.scheduled_job_runs to service_role;

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

-- Long-lived agent runs. The API and agent-step Lambdas write with the service
-- role and check user_id in code. The browser reads under RLS.

create table public.agent_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  system_prompt text not null check (char_length(system_prompt) between 1 and 4000),
  allowed_tools text[] not null default '{}',
  approval_required text[] not null default '{}',
  model_chain jsonb not null,
  allowed_providers text[] not null default '{}',
  max_steps int not null default 25 check (max_steps between 1 and 100),
  max_runtime_min int not null default 60 check (max_runtime_min between 1 and 1440),
  token_budget int not null default 60000 check (token_budget between 1000 and 500000),
  resource_scopes jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index agent_profiles_user_updated_idx
  on public.agent_profiles (user_id, updated_at desc);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  profile_id uuid not null references public.agent_profiles (id),
  profile_snapshot jsonb not null,
  command text not null check (char_length(command) between 1 and 4000),
  trigger text not null default 'manual' check (trigger in ('manual', 'schedule', 'webhook')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_input', 'waiting_approval', 'done', 'failed', 'cancelled')),
  messages jsonb not null default '[]'::jsonb,
  summary text not null default '' check (char_length(summary) <= 4000),
  scratchpad text not null default '' check (char_length(scratchpad) <= 2000),
  summary_until int not null default 0 check (summary_until >= 0),
  pending_request jsonb,
  result_summary text check (result_summary is null or char_length(result_summary) <= 4000),
  error text check (error is null or char_length(error) <= 500),
  step_count int not null default 0 check (step_count >= 0),
  tokens_used int not null default 0 check (tokens_used >= 0),
  no_tool_streak int not null default 0 check (no_tool_streak >= 0),
  consecutive_errors int not null default 0 check (consecutive_errors >= 0),
  next_attempt_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index agent_runs_user_status_updated_idx
  on public.agent_runs (user_id, status, updated_at desc);

create table public.agent_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  seq int not null check (seq >= 1),
  type text not null
    check (type in (
      'started', 'thought', 'tool_call', 'tool_result', 'tool_blocked',
      'question', 'answer', 'approval_request', 'approval',
      'summary', 'provider_fallback', 'rate_limited',
      'finished', 'failed', 'cancelled'
    )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create index agent_events_run_seq_idx
  on public.agent_events (run_id, seq);

create table public.agent_tool_calls (
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  tool_call_id text not null check (char_length(tool_call_id) between 1 and 120),
  tool_name text not null,
  args jsonb not null,
  status text not null check (status in ('pending', 'done', 'error')),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, tool_call_id)
);

create table public.token_ledger (
  day date not null,
  provider text not null,
  source text not null,
  tokens bigint not null default 0 check (tokens >= 0),
  requests int not null default 0 check (requests >= 0),
  primary key (day, provider, source)
);

alter table public.agent_profiles enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_events enable row level security;
alter table public.agent_tool_calls enable row level security;
alter table public.token_ledger enable row level security;

grant select on public.agent_profiles to authenticated;
grant select on public.agent_runs to authenticated;
grant select on public.agent_events to authenticated;
grant select on public.agent_tool_calls to authenticated;
grant all on public.agent_profiles to service_role;
grant all on public.agent_runs to service_role;
grant all on public.agent_events to service_role;
grant all on public.agent_tool_calls to service_role;
grant all on public.token_ledger to service_role;

create policy agent_profiles_owner_select on public.agent_profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy agent_runs_owner_select on public.agent_runs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy agent_events_owner_select on public.agent_events
  for select to authenticated
  using (
    exists (
      select 1 from public.agent_runs r
      where r.id = run_id and r.user_id = (select auth.uid())
    )
  );

create policy agent_tool_calls_owner_select on public.agent_tool_calls
  for select to authenticated
  using (
    exists (
      select 1 from public.agent_runs r
      where r.id = run_id and r.user_id = (select auth.uid())
    )
  );

alter table public.agent_runs replica identity full;
alter table public.agent_events replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_runs'
  ) then
    alter publication supabase_realtime add table public.agent_runs;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_events'
  ) then
    alter publication supabase_realtime add table public.agent_events;
  end if;
end $$;

create or replace function public.increment_token_ledger(
  p_day date,
  p_provider text,
  p_source text,
  p_tokens bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.token_ledger (day, provider, source, tokens, requests)
  values (p_day, p_provider, p_source, greatest(p_tokens, 0), 1)
  on conflict (day, provider, source)
  do update set
    tokens = public.token_ledger.tokens + excluded.tokens,
    requests = public.token_ledger.requests + 1;
end;
$$;

revoke all on function public.increment_token_ledger(date, text, text, bigint) from public;
grant execute on function public.increment_token_ledger(date, text, text, bigint) to service_role;

