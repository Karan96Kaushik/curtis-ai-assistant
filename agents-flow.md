# Agent flow

An agent run is a resumable job. State lives in Postgres. Each step is one model call, then at most two tool calls. The run can pause for a question or an approval and continue later. Chat turns are separate: they finish in one Lambda invocation and cannot pause.

Messaging is notification-only. An Android app writes phone notification rows into Supabase. The agent reads filtered previews from that table. It cannot open a mail thread, fetch a full WhatsApp conversation, or send a message.

## Pieces

```
Browser  /agents
  │  POST agentApi (Supabase JWT)
  ▼
agentApi
  │  insert agent_runs (status queued)
  │  enqueue SQS message  run_id + expected_step 0
  ▼
FIFO queue  MessageGroupId = run_id
  │
  ▼
agentStep   one step, then enqueue the next step or stop
  │
  ├── Groq, then the rest of the profile's model chain
  ├── tools allowed by the profile snapshot
  └── push on question, approval, done, or failure
```

A schedule uses the same run. `scheduleTick` claims a due job and invokes `runScheduledJob`. If the job has a profile, that function creates an agent run with trigger `schedule` and enqueues step 0.

## Notification inputs

| Source | What the agent sees |
| --- | --- |
| `notifications` table | Truncated lock-screen previews: app, title/sender, snippet or stored body |
| Not available | Full email bodies, WhatsApp threads, send credentials |

Core rules always cover tools, untrusted data, scratchpad, and finish. Notification-specific lines (previews, `notification_app_stats` before search, `draft_reply`) are added only when those tools are in the profile allowlist. OTP codes, card numbers, and password-reset links are redacted in the tool layer before they reach a provider.

Every notification tool returns a coverage note from the newest `notifications` row, for example `newest stored notification 3 min ago`. The phone writes those rows directly. `device_tokens` is only for outbound FCM and is not a sign that notification capture is healthy. A quiet window is not reported as a down listener or an offline phone.

### Notification tools

| Tool | Purpose |
| --- | --- |
| `notification_app_stats(hours 1–168?, since?, until?)` | Per-app counts for a duration. Default last 24 hours. Useful before searching when this tool is allowed |
| `search_notifications(app?, exclude_app?, sender?, text?, category?, since?, until?, hours 1–168, limit<=40)` | Targeted reads. Default 7-day window, default limit 20. Dedupes repeated pings from the same chat |
| `notification_digest(since, group_by: app\|sender)` | Counts and top senders in a few hundred tokens |
| `get_notification(id)` | Full stored text of one item (still a preview, still redacted) |
| `list_notification_apps()` | Apps this profile may query |
| `get_more(offset, …same filters)` | Next page of a search |
| `draft_reply(notification_id, body)` | Stores a mailto / wa.me draft from the stored contact and pushes a tap-to-open link. The user sends it |

There are no `email.*` or `whatsapp.*` tools. `send_push_notification` reaches only the user's own devices.

### App scoping

Profiles have `allowed_apps text[]`.

- Empty: every non-sensitive app.
- Non-empty: only matching app names or package fragments.
- Banking, OTP, and authenticator apps stay hidden unless explicitly listed.

Filtering happens in the notification store, not in the prompt.

## Profiles

A profile is the permission and model policy for a run. The run copies it into `profile_snapshot` at start, so later edits do not change a run that has already started.

| Field | Role |
| --- | --- |
| `system_prompt` | Instructions prepended to every step |
| `model_chain` | Ordered fallback list |
| `allowed_providers` | Providers that chain entries must use |
| `allowed_tools` | Functions the model may call, besides the core tools |
| `approval_required` | Subset of `allowed_tools` that pause for approval |
| `allowed_apps` | Notification app allowlist (see above) |
| `max_steps` / `max_runtime_min` / `token_budget` | Run limits |

A run without a chosen profile uses the profile marked as the default. If none is marked, the first such run creates a system Inbox profile and marks it default. Inbox may use the notification tools and `draft_reply`. It uses Groq, then Google. That chain is deliberate: every notification read sends private text to a third party.

Saving a profile checks:

- Name, prompt, limits, model ids, and allowed apps are in range.
- Every allowed tool is known. Core tools cannot require approval.
- The model chain is non-empty after applying `allowed_providers`.
- **Egress rule:** if the profile can read private notifications and can write outside the user's devices, every egress tool in the allowlist must be in `approval_required`. Egress is tool metadata (`egress: true`), not a hard-coded name list. It covers Jira/GitHub writes, `browser_type`, `wf_release_execute_pending`, and `schedule_task` (it can plant a later prompt). `send_push_notification` and `draft_reply` are not egress.

Turning a write on in the editor also requires approval until that box is cleared.

## Starting a run

`agentApi` accepts a Supabase user who is in `ALLOWED_EMAILS`.

| Action | Effect |
| --- | --- |
| `create` | New run from `command` and optional `profile_id`. Status `queued`. Enqueue step 0 |
| `answer` | Resume a run in `waiting_input` |
| `approval` | `approve` or `deny` a run in `waiting_approval` |
| `cancel` / `retry` / `save_profile` | As named |
| `continue` | New run after `done` / `failed` / `cancelled`, with prior outcome + additional instructions |
| `analyze_profile_run` | LLM-only review of **one** finished run. Returns suggested Instructions. Does not write the profile |
| `improve_prompt` | Rewrite Instructions for clarity. Result is clamped to at most 2× the source word count. Does not write the profile |

Each step emits a `thought` with the model’s plain-text update, or a synthesized “Working on: …” line when the model only returns tool calls. `finish` and failures both write `result_summary` for the run page.

UI: `/agents`, `/agents/runs/:runId`, `/agents/profiles/new`, `/agents/profiles/:profileId`.

### Profile analytics

From the profile editor, pick one finished run (`done`, `failed`, or `cancelled`) and call `analyze_profile_run`. The API builds a redacted pack from that run’s command, outcome, and events, then asks the profile’s model chain (no tools) for `{ rationale, suggested_system_prompt, change_bullets }`.

The editor shows the suggestion. **Apply** copies it into Instructions in the page only. **Save profile** is still required. Analysis is never aggregated across runs. A run detail page can deep-link with `?analyzeRun=`.

## One step

`agentStep` loads the run and handles the SQS message.

1. Ignore when missing, cancelled, or not `queued`/`running`.
2. If `step_count` is already ahead of `expected_step`, re-enqueue the current step (heal a lost enqueue). Do not call the model.
3. If `next_attempt_at` is still in the future, requeue the same step (15–900s). Does not increment `step_count`.
4. Fail when runtime, max steps, or token budget is spent.
5. Move `queued` → `running` and set `started_at` on first claim.
6. Call the model with connected, allowed tools.
7. Pause, finish, fail, or enqueue `expected_step = step_count`.

SQS is FIFO. `MessageGroupId` is the run id. Dedup id is `run_id:expected_step:nonce` (`start`, `next`, `resume:<time>`, `wait:<next_attempt_at>`, `heal:<time>`, `recover:<time>`). Visibility 180s, Lambda timeout 120s, batch size 1, DLQ after 3 receives.

A step emits a short `thought` before the model call so the run page moves. If the Lambda throws, the run is marked `failed` instead of staying `running`. `scheduleTick` re-enqueues queued/running rows whose `updated_at` is older than 4 minutes (or fails them when max runtime is past).

## Model chain

Walk the profile chain in order. Missing keys skip. 429/5xx/timeouts try the next entry; if all remaining attempts are retryable, requeue the same step for up to 15 minutes. Non-retryable errors fail the run.

Stored assistant tool calls are flat; the provider request rewrites them to OpenAI shape (`type: "function"`) so Groq accepts a replayed history.

## Prompt

1. System: profile prompt + core rules (previews, untrusted data, draft_reply, finish).
2. User: goal, scratchpad (800 chars), rolling summary (1200 chars).
3. Last six stored messages.

When the estimate exceeds 60% of usable context (8000 for Google-first, else 6000), older messages fold into the summary. Non-core tool results are truncated and wrapped in `<untrusted_data>`.

## Tools (connected today)

| Tool | Effect |
| --- | --- |
| `ask_user` / `finish` / `update_scratchpad` | Always on |
| Notification tools above | Read/filter/redact from `notifications` |
| `draft_reply` | Push + run-page link; user sends |
| `send_push_notification` | Rich FCM to own devices (title/body + channel, key, deep link, actions, progress). Android contract: `context/android-push-notifications-spec.md` |
| `schedule_task` / `list_schedules` / `cancel_schedule` | Agent schedules on this profile |

Granted but not connected tools stay off the model until a handler exists. Chat session controls (`confirm_pending`, `think`, …) are not profile permissions.

## Pause and resume

`ask_user` and approval do not increment `step_count`. Answer or approval decision writes the tool result, sets `running`, and enqueues the same step with nonce `resume:<timestamp>`. Push links to `/agents/runs/{id}`.

## Schedules

Chat schedules still belong to a conversation. Agent schedules belong to a profile (`profile_id` set, `conversation_id` null). When due, `runScheduledJob` starts an agent run with trigger `schedule`. `schedule_task` is egress because it can plant a later prompt that reads notifications and writes elsewhere.

## Statuses

`queued`, `running`, `waiting_input`, `waiting_approval`, `done`, `failed`, `cancelled`. Status changes are conditional updates.

## Data

- `0007_agent_runs.sql` — profiles, runs, events, tool calls, token ledger
- `0008_agent_schedules.sql` — agent schedule target (`profile_id`)
- `0009_notification_profile_apps.sql` — `allowed_apps`

Owner reads under RLS. Step and schedule functions write with the service role.

## Planned (not yet wired)

These stay on the roadmap from the notification revision and earlier hardening notes:

- `wait` / `wait_until` to resume the same run; pause the runtime clock while waiting
- Per-profile `remember` / `recall` memory table
- Notification event triggers (DB webhook → `agentApi create`) with debounce, concurrency cap, and daily run limit
- Retention TTL on `notifications` and agent `messages`
- Dedicated DLQ consumer (stall reclaim currently runs from `scheduleTick`)
- Crash-safe step replay: persist model response before tool execution with the `step_count` bump
- Cut the last-N window on assistant-turn boundaries; schedule depth/overlap policy; per-attempt model timeouts with a longer SQS visibility timeout
