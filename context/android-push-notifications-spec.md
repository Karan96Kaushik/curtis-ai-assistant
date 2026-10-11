# Android app: rich Curtis push notifications

Counterpart to the server contract in `lib/push/payload.ts` and the agent tool `send_push_notification`.

The backend sends FCM v1 messages with both a system `notification` block (fallback) and a structured `data` map. The Android app should treat **`data` as the source of truth** and post / update a local `NotificationCompat` so actions, progress, grouping, and Live Updates work reliably (including when the app is in the foreground).

## Delivery model

| Piece | Role |
| --- | --- |
| `message.notification` | Title/body fallback if the app does not handle the message |
| `message.android.notification` | Channel, tag, image, click_action, priority hints |
| `message.data` | Canonical rich payload (`curtis_*` keys) |

**Recommended receive path**

1. `FirebaseMessagingService.onMessageReceived` always runs when the app can handle data.
2. If `data["curtis_v"]` is present, **build and post the notification yourself** (do not rely on the system tray auto-display for rich features).
3. Use `curtis_notification_key` (or a hash of it) as the Android notification id so updates replace the same shade entry.
4. Honor `curtis_expires_at`: schedule cancel, or drop if already past.
5. On cold start from a tap, read the same keys from the launching `Intent` extras (mirror `data` into the intent).

When the app is killed, Android may still show the FCM `notification` block. Keep title/body useful there; rich UI appears once the app processes `data` (or on next open). Prefer data-capable delivery (high priority + app handling) for progress/actions.

## Protocol version

- `curtis_v` = `"1"` — current schema.
- Ignore unknown keys; fail soft on malformed optional JSON.
- Reject / ignore payloads missing `curtis_title` + `curtis_body` when `curtis_v` is set.

## Channels (create at app start)

| Logical `curtis_channel` | Channel id (`curtis_channel_id`) | Importance | Notes |
| --- | --- | --- | --- |
| `urgent` | `curtis_urgent` | HIGH | Heads-up allowed; Android 15+ may use richer channel vibration |
| `default` | `curtis_default` | DEFAULT | Normal alerts |
| `digest` | `curtis_digest` | LOW | Summaries / digests |
| `progress` | `curtis_progress` | DEFAULT | Ongoing journeys; good candidate for Live Updates |
| `quiet` | `curtis_quiet` | LOW | Silent / no heads-up |

Map `curtis_channel_id` to `NotificationCompat.Builder.setChannelId`. If the id is unknown, fall back to `curtis_default`.

## Data keys (`curtis_*`)

All values are strings.

| Key | Required | Meaning |
| --- | --- | --- |
| `curtis_v` | yes | Protocol version (`1`) |
| `curtis_title` | yes | Content title |
| `curtis_body` | yes | Content text |
| `curtis_subtitle` | | `setSubText` / header context |
| `curtis_expanded_body` | | BigText expanded body (else use body) |
| `curtis_category` | | One of: `msg`, `email`, `reminder`, `progress`, `recommendation`, `status`, `promo` → map to `NotificationCompat.CATEGORY_*` |
| `curtis_channel` | yes | Logical channel (table above) |
| `curtis_channel_id` | yes | Exact NotificationChannel id |
| `curtis_urgency` | yes | `low` \| `normal` \| `high` |
| `curtis_silent` | yes | `1` / `0` — suppress sound/heads-up |
| `curtis_notification_key` | | Stable replace key → notification id + `setGroup` helper; also FCM collapse key |
| `curtis_group_key` | | `setGroup` |
| `curtis_deep_link` | | Path or URL to open on content tap |
| `curtis_image_url` | | https image for BigPicture |
| `curtis_large_icon_url` | | https large icon |
| `curtis_related_notification_id` | | Server id of an inbound phone notification row |
| `curtis_when` | | ISO-8601 → `setWhen` / `setShowWhen` |
| `curtis_expires_at` | | ISO-8601 → auto-cancel |
| `curtis_only_alert_once` | yes | `1` / `0` → `setOnlyAlertOnce` |
| `curtis_style` | yes | `default` \| `big_text` \| `big_picture` \| `progress` |
| `curtis_progress_current` | if progress | Integer |
| `curtis_progress_max` | if progress | Integer ≥ 1 |
| `curtis_progress_indeterminate` | | `1` → indeterminate bar |
| `curtis_short_critical_text` | | ≤ 8 chars for status-bar chip (Live Updates) |
| `curtis_ongoing` | yes | `1` → `setOngoing(true)` |
| `curtis_request_promoted` | yes | `1` → request Live Update promotion (Android 16+) |
| `curtis_actions` | | JSON array: `[{"id":"open","label":"Open"}, …]` max 3 |

Non-`curtis_*` keys (e.g. `run_id`, `link`, `jobId`) are opaque extras — forward into the tap/action intents.

## Styles

### `default`

Standard notification. If `curtis_expanded_body` is set, use `BigTextStyle` with that text.

### `big_text`

`NotificationCompat.BigTextStyle` with `curtis_expanded_body` or `curtis_body`.

### `big_picture`

Load `curtis_image_url` (https only, reasonable size/timeout). Use `BigPictureStyle`. On failure, fall back to big text / default.

### `progress`

- Use `setProgress(max, current, indeterminate)` from the progress keys.
- On Android 16+, prefer `Notification.ProgressStyle` / Compose Live Update APIs when available; keep Compat progress as fallback.
- Keep `ongoing` until the server sends a final update with `curtis_ongoing=0` or a terminal title/body, then clear ongoing and (optionally) auto-dismiss after a short delay.
- Segments/milestones are not in v1; a future `curtis_progress_segments` JSON may appear — ignore until documented.

## Live Updates (Android 16+)

When `curtis_request_promoted=1` and `curtis_ongoing=1`:

1. Declare `android.permission.POST_PROMOTED_NOTIFICATIONS` (non-runtime).
2. Use a promotable style: Standard, BigText, Progress (or Metric/Call if you add them later).
3. Call `setRequestPromotedOngoing(true)` / `EXTRA_REQUEST_PROMOTED_ONGOING`.
4. Set `FLAG_ONGOING_EVENT`.
5. Use `curtis_short_critical_text` or `curtis_when` for the status chip when relevant.
6. Check `NotificationManager.canPostPromotedNotifications()`; if false, still post a normal ongoing notification.

Only use for user-initiated, in-progress work with a clear end (scheduled job running, release workflow, long agent task).

## Actions

Parse `curtis_actions` JSON. Allowed `id` values:

| id | App behavior |
| --- | --- |
| `open` | Open `curtis_deep_link` or app home / run page from extras |
| `snooze` | Local snooze (e.g. 15 / 60 minutes) then re-post or schedule; optional server callback later |
| `mark_done` | Dismiss notification; if `curtis_related_notification_id` set, mark that inbox item done locally if supported |
| `open_draft` | Open draft / reply UI using `link` / `notification_id` extras |
| `view_issue` | Open Jira/GitHub issue from deep link or extras |

Rules:

- Max 3 actions; each needs icon + label + `PendingIntent`.
- Use unique request codes per action + notification key.
- Prefer immutable `PendingIntent`s; launch activities directly when opening UI (Android 12+ background restrictions).
- Unknown `id`: skip that action.
- Do **not** execute arbitrary URLs from labels; only handle the enum ids above.

## Deep links

`curtis_deep_link` may be:

- App path: `/agents/runs/{id}`, `/chat/{conversationId}`, …
- `https://` app link if you use verified App Links
- `mailto:` / `https://wa.me/…` for draft replies

On content tap and on `open` / `open_draft` / `view_issue`, route through one navigator. Validate host/path against an allowlist before opening external browsers.

Also honor FCM `android.notification.click_action = CURTIS_OPEN`: register an activity intent-filter for that action and read extras the same way.

## Category mapping

| `curtis_category` | `NotificationCompat` |
| --- | --- |
| `msg` | `CATEGORY_MESSAGE` |
| `email` | `CATEGORY_EMAIL` |
| `reminder` | `CATEGORY_REMINDER` |
| `progress` | `CATEGORY_PROGRESS` |
| `recommendation` | `CATEGORY_RECOMMENDATION` |
| `status` | `CATEGORY_STATUS` |
| `promo` | `CATEGORY_PROMO` |
| (missing) | omit / `CATEGORY_STATUS` |

## Urgency & silent

- `curtis_silent=1` → no sound/vibration; low visual interrupt (`setSilent` / channel quiet).
- `curtis_urgency=high` → heads-up when channel allows; not a substitute for channel importance on Android 8+.
- `curtis_only_alert_once=1` → updates to the same key must not re-alert.

## Grouping

- `curtis_group_key` → `setGroup`.
- Optionally post a summary notification for the group when more than one child is active.
- `curtis_notification_key` alone should still replace by notification id even without a group.

## Images

- Only `https` URLs (server already enforces this).
- Timeout downloads (~3–5s); max dimensions ~2MP; no cleartext.
- Cache by URL briefly to support rapid progress updates that repeat the same icon.

## Token registration

Unchanged: while signed in, upsert FCM token to Supabase `device_tokens` for the user. Delete on logout. Server removes stale tokens on FCM `UNREGISTERED`.

## Permissions

- `POST_NOTIFICATIONS` (runtime, API 33+)
- `POST_PROMOTED_NOTIFICATIONS` (manifest, for Live Updates)
- Create all five channels before the first rich push

## Acceptance checks

1. Basic title/body still shows if the app only handles the notification block.
2. Same `curtis_notification_key` updates one shade entry without stacking.
3. Progress style shows a bar; final update clears ongoing.
4. Actions appear (≤3) and only the documented ids run.
5. Deep link opens the correct in-app screen.
6. Quiet/digest channels do not heads-up.
7. On Android 16, promoted ongoing + short critical text appears when allowed.
8. Malformed `curtis_actions` does not crash the service.

## Out of scope (v1)

- Custom RemoteViews layouts
- Agent-defined vibration patterns (use channel settings / Android 15 channel vibration)
- MessagingStyle conversation threads
- Arbitrary action intents or JavaScript from the payload
- Progress segments/milestones JSON (reserved for a later protocol bump)
