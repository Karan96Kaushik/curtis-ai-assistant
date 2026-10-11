-- Agent runs can schedule later work. Those jobs point at a profile instead of a chat.
-- When the tick fires, runScheduledJob starts an agent run with that profile.

alter table public.scheduled_jobs
  alter column conversation_id drop not null;

alter table public.scheduled_jobs
  add column profile_id uuid references public.agent_profiles (id) on delete cascade;

alter table public.scheduled_jobs
  add constraint scheduled_jobs_target_chk check (
    (conversation_id is not null and profile_id is null)
    or (conversation_id is null and profile_id is not null)
  );

alter table public.scheduled_job_runs
  add column agent_run_id uuid references public.agent_runs (id) on delete set null;
