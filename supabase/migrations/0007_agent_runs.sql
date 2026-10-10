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
