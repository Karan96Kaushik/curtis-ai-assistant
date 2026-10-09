-- Durable markdown contexts owned by the signed-in user.
-- `behavior` is the only behavior document; the app writes it after the user
-- approves a proposal. Reference rows hold org memory and other specs.

create table public.contexts (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null check (char_length(title) between 1 and 120),
  kind text not null check (kind in ('reference', 'behavior')),
  content text not null default '' check (char_length(content) <= 100000),
  updated_at timestamptz not null default now(),
  primary key (user_id, slug)
);

create unique index contexts_one_behavior_idx
  on public.contexts (user_id)
  where kind = 'behavior';

alter table public.contexts enable row level security;

grant select, insert, update, delete on public.contexts to authenticated;

create policy contexts_owner on public.contexts
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
