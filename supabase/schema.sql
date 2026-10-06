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
