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
