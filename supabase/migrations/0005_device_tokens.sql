-- FCM registration tokens for Android (and later iOS) push delivery.
-- The mobile app upserts its token after Firebase Messaging init + Supabase sign-in.
-- The Amplify sendPush Lambda reads tokens under the caller's JWT / RLS.

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
