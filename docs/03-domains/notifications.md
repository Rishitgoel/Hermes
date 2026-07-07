# Domain: Notifications

**Key files:** `services/notification.service.ts`, `services/notification-stream.service.ts`,
`controllers/notification.controller.ts`, `services/slack.service.ts`,
`services/email.service.ts`. Data model: `Notification`.

## Two-service split: persistent vs. real-time

- **`NotificationService`** — the "broadcast" layer. Writes a `Notification` row
  (title, message, linkUrl, isRead) to Postgres, and emits a `notification.created` event
  onto the [event bus](../01-architecture.md#event-bus). Also owns `emailAndDm()` (fires
  an email + Slack DM concurrently via `Promise.allSettled`, so one channel's failure
  never blocks the other) and `fanOutToAdmins()` (de-dupes by userId — someone who's both
  a group admin and platform admin for the same event gets notified once, not twice).
- **`NotificationStreamService`** — the real-time layer. Holds an in-process
  `Map<userId, Set<Response>>` of open SSE connections, listens for `notification.created`
  on the event bus (a single shared listener, not one per connection, to avoid
  `EventEmitter` max-listeners warnings), and pushes each new notification down every
  open connection for that user. `ROADMAP.md` (P3-2) notes this moves to a Redis-backed
  bus eventually; the client registry and route stay the same when that happens.

## What triggers a notification

Every domain event gets a dedicated method on `NotificationService`, each following the
same "in-app + email + Slack" pattern:

| Event | Method | Recipients |
|---|---|---|
| Request created | `notifyRequestCreated` / `notifyRequestsCreatedBulk` | group/platform/super admins + team Slack ping |
| Request approved/rejected | `notifyRequestReviewed` | requester |
| Access queued for setup | `notifyAccessQueuedForSetup` | requester |
| Access expired | `notifyAccessExpired` | requester + team Slack ping |
| Auto-expiry permanently failed | `notifyExpiryFailed` | super/platform admins (manual cleanup needed) |
| Access revoked | `notifyAccessRevoked` | requester + team Slack ping |
| ZK change submitted/reviewed | `notifyZkChangeRequestCreated` / `Reviewed` | involved group admins / requester |
| Secret ingestion submitted/reviewed | `notifySecretIngestionSubmitted` / `Reviewed` | involved group admins / requester |
| User creation submitted/approved/rejected/completed | `notifyUserCreation*` | admins / requester |

`notifyUserCreationCompleted()` is worth calling out specifically: it asks the platform
adapter for a custom `getOnboardingMessage()` (e.g. ZooKeeper's credential digest copy)
and falls back to generic copy if the adapter doesn't customize it.

User-supplied text (justifications, notes) is escaped before going into Slack messages
(`escapeSlackText()`) to prevent markdown injection.

## Channels

- **Slack** (`slack.service.ts`): `sendPing()` posts to a shared webhook channel;
  `sendDirectMessage()` DMs a specific user (resolved by email via the Slack Web API,
  requires a bot token with `users:read.email` + `chat:write`). Both fail silently
  (logged, swallowed) — a Slack outage must never block an approval.
- **Email** (`email.service.ts`): thin AWS SES v2 wrapper. Also fails silently for the
  same reason. Falls back to the SDK's default credential provider chain if
  `AWS_ACCESS_KEY_ID`/`SECRET` aren't set (i.e. uses the instance/task IAM role).
- Both are **simulation-aware** — no webhook URL / bot token / SES sender configured
  means the call just logs instead of sending, which is the default in dev.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications/stream` | SSE; token passed as `?token=` since `EventSource` can't set headers; 25s heartbeat to keep intermediate proxies from closing it |
| GET | `/api/notifications` | Most recent 50 |
| GET | `/api/notifications/unread-count` | True total (not capped at 50) |
| PUT | `/api/notifications/read-all` / `/:id/read` | Mark read |
| DELETE | `/api/notifications` / `/:id` | Clear all / dismiss one |

## Gotchas

- **No retry on delivery failure.** The in-app notification always persists; email/Slack
  failures are logged and silently dropped — there is no queue or retry.
- **SSE is per-tab, not per-user.** Three open tabs for the same user = three
  connections, each receiving the same notification independently; de-duplication (if
  any) is the frontend's job.
- **Notification prune is a hard cap, not just a cleanup**: the scheduler deletes read
  notifications >30 days old, and *any* notification (read or not) >90 days old — so an
  unread bell can't accumulate indefinitely.
