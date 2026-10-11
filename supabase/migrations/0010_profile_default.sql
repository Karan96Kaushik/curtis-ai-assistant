-- One default profile per user. Runs started without a chosen profile use it.
-- Existing system Inbox profiles become the default.

alter table public.agent_profiles
  add column is_default boolean not null default false;

comment on column public.agent_profiles.is_default is
  'When true, runs started without a chosen profile use this profile. At most one per user.';

with chosen as (
  select distinct on (user_id) id
  from public.agent_profiles
  where is_system and name = 'Inbox'
  order by user_id, created_at
)
update public.agent_profiles as profile
set is_default = true
from chosen
where profile.id = chosen.id;

create unique index agent_profiles_one_default_idx
  on public.agent_profiles (user_id)
  where is_default;
