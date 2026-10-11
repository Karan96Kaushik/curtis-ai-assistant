-- App scoping for notification-reading profiles.
-- Empty allowed_apps means every non-sensitive app. Banking/OTP apps stay hidden unless listed.
-- Sensitive redaction and coverage notes live in the agent tool layer.

alter table public.agent_profiles
  add column allowed_apps text[] not null default '{}';

comment on column public.agent_profiles.allowed_apps is
  'App name or package fragments the profile may read from notifications. Empty = all non-sensitive apps.';
