# Production acceptance (ESZ-086 / ESZ-129)

Status: **prepared, not accepted**. This procedure has not been run against a
deployed target. Running repository tests or the read-only mode does not close
ESZ-086.

Before either read-only or state-changing acceptance can complete, the operator must
run the host-side log-sink preflight against the deployed configuration and record
`preflight:production PASS`:

```sh
cd /usr/home/<FTP_LOGIN>/eszter/app && /usr/bin/php bin/preflight-production.php \
  --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php
```

This prerequisite proves that the configured application log can be created, opened,
restricted to `0600` and written. The HTTP acceptance pass is unchanged and contains
no logging check: readiness proves serving dependencies only, so it cannot replace
the host preflight or declare production acceptable by itself.

## Authorization boundary

The harness needs an explicit HTTPS origin even for read-only checks:

```sh
ESZTER_ACCEPTANCE_TARGET_URL=https://<DEPLOYED-ORIGIN>/ npm run acceptance:production
```

Read-only mode runs the unchanged project readiness probe (`scripts/readiness.mjs`,
ESZ-127/AUD-22) against the origin: `/api/health` (liveness under its frozen
contract), the homepage bootstrap, the published `/api/content` envelope, and
`/api/booking/services` reaching at least one active bookable service — the
surface that would fail if MySQL/booking were unavailable while the service
stayed live. It cannot log in, upload, book, mutate or cancel, and it does not test
the host log target. Read-only mode never reads or writes the cleanup-debt store.

State-changing mode is deliberately cumbersome. The deployment owner must approve
the target, the admin account and a mailbox that may receive the test messages, then
set secrets in the environment (never in command arguments or Git) and supply the
exact confirmation phrase:

```sh
ESZTER_ACCEPTANCE_TARGET_URL=https://<DEPLOYED-ORIGIN>/ \
ESZTER_ACCEPTANCE_ADMIN_EMAIL='<ADMIN>' \
ESZTER_ACCEPTANCE_ADMIN_PASSWORD='<PASSWORD>' \
ESZTER_ACCEPTANCE_CUSTOMER_EMAIL='<APPROVED-MAILBOX>' \
npm run acceptance:production -- \
  --live-confirmation=I_AUTHORIZE_ESZTER_LIVE_MUTATIONS
```

The harness refuses HTTP, URLs with embedded credentials, paths, query strings or
fragments. It reads passwords only from the environment. Do not run it merely
because a deployment exists: the flag is confirmation that creating and cancelling
a real booking and sending messages to the named mailbox is authorized now.

## What the state-changing pass does

The state-changing core (`scripts/production-acceptance-core.mjs`) is a state
machine over the created resources, not a linear script: every resource/state
transition is **tracked the moment it exists** and every cleanup is **verified
against authoritative state** (the admin media library, the admin reference query,
a protected probe) before it counts as done.

1. Readiness probe (read-only): health = liveness under its contract, exported
   public page, published envelope, at least one active bookable service. An
   authorized run refuses to start at all while an unresolved cleanup debt exists
   for the target origin (see below) — before creating any session, upload or
   booking.
2. Anonymous session, CSRF-bound login and rotated authenticated session. The
   authenticated session is tracked; logging out destroys its server-side row.
3. Upload a generated PNG named with an `ESZ-086-<timestamp>-<random>` marker,
   assert its server id, delete it immediately and **verify the asset is absent**
   from the admin media library.
4. Read active services and authoritative availability, and pick the first free
   slot in days 2–60. The window is walked in bounded sub-windows because the
   booking engine answers at most its contract-bounded result count per query.
5. Create one marker-named booking for the approved mailbox; the booking is
   tracked immediately.
6. Find that exact reference through the admin booking query/calendar surface
   (the ESZ-145 envelope), update its note **carrying the booking's current
   `expectedUpdatedAt`** (ESZ-139), then re-read a fresh token and cancel it
   through the admin surface with that token. A stale token would answer 409
   REVISION_CONFLICT and write nothing, so a successful cancel proves the token
   was current. Cancellation never deletes the row.
7. On normal success the core verifies, in order: media absent, booking cancelled,
   session logged out, and the protected surface answering 401 to a session-less
   probe. Only then does the run report PASS and print the LIVE-PENDING mailbox
   and browser-worksheet reminders.

The create and cancel operations enqueue the essential confirmation and cancellation
e-mail lifecycle. The harness cannot honestly claim delivery: there is intentionally
no public queue-inspection API, and cron/SMTP/mailbox receipt are deployment-owned.

## Failure: automatic compensation, then the cleanup debt

On **any** failure the core compensates in the ticket's safe order — media first,
then the booking, then the session. Every compensation action is verify-first and
therefore **idempotent**: already-deleted media, an already-cancelled booking and
an already-invalidated session verify clean instead of failing again; the booking
is cancelled only when a fresh reference query shows it still `confirmed`, and
always with that fresh `expectedUpdatedAt`. The **original failure stays a
failure** even when the compensation fully succeeds: a compensated run exits 1 and
never reads as PASS.

| Created resource | Cleanup action | Verification | Clean when |
|---|---|---|---|
| Media asset | delete through `DELETE /api/admin/media` | admin media list re-query | deleted (204/404) and absent; or absent on first check |
| Booking | cancel through `PATCH /api/admin/bookings` with a freshly queried `expectedUpdatedAt` | admin reference query | cancel 200 + re-query `cancelled`; already `cancelled`; 409 + re-query shows `cancelled`; or absent (404) |
| Admin session | `POST /api/auth/logout` (destroys the server-side row) | protected probe | logout 204 or 401 **and** the probe answers 401 |

If a step cannot be verified clean, the core persists a **cleanup-debt record** and
the run still fails. The record is per target origin, one file per origin:

- location: `~/.eszter/acceptance-debt/` (override `ESZTER_ACCEPTANCE_DEBT_DIR`
  relocates the whole store — it never disables the gate);
- file mode `0600`, directory mode `0700`, written atomically (temp file + rename);
- contents: `{formatVersion, origin, marker, createdAt, steps}` where each step is
  `{kind: media|booking|session, attempted: delete|cancel|logout, status: pending}`
  plus the opaque `mediaId` / `bookingReference`. **Never** stored: admin/customer
  e-mail addresses, passwords, cookies, CSRF tokens, message bodies or any other
  PII — the format is closed and audited on write and on load.

While an unresolved debt exists for the origin, every later state-changing run is
refused **before creating any new mutation** (the refusal happens before the
readiness probe, the session, any POST/upload/booking). Read-only mode is not
affected. There is no `--force`, flag or comment escape hatch that bypasses an
unresolved debt; the cleanup/resume mode below is the only way forward.

### Cleanup/resume mode

```sh
ESZTER_ACCEPTANCE_TARGET_URL=https://<DEPLOYED-ORIGIN>/ \
npm run acceptance:production -- --cleanup \
  --live-confirmation=I_AUTHORIZE_ESZTER_LIVE_MUTATIONS
```

It carries the same authorization envelope (HTTPS origin + exact phrase). Secrets
come from the environment and are read **only when required**: a debt whose
recorded steps need the admin surface (media, booking) requires
`ESZTER_ACCEPTANCE_ADMIN_EMAIL` and `ESZTER_ACCEPTANCE_ADMIN_PASSWORD`; a
session-only debt resolves without any credential. The mode:

1. loads the debt (a corrupt or unreadable record refuses to run: nothing proceeds);
2. authenticates only when a recorded step needs the admin surface;
3. retries the safe cleanup in the recorded order, every action verify-first;
4. re-queries authoritative state (media list, reference query, protected probe);
5. deletes the debt record **only after every recorded resource is verified
   clean** — otherwise the debt is kept and the exit code is 1.

A recorded `session` step means the failing run's logout could not be verified:
the acceptance session's cookie is never persisted (the debt format forbids it), so
no public endpoint can address the server-side row without it. The row is bounded by
the application's absolute session lifetime and removed by its own bounded GC sweep
(ESZ-130); the cleanup run records that verification and the debt is removed with
the other verified steps. The cleanup run also logs out the session it authenticated
with, so cleanup itself leaves nothing behind.

## Browser and mailbox worksheet

Record date/time, deployed release digest, target origin, operator and the harness
marker/reference. Do not paste credentials, customer details or message bodies.

| Checkpoint | Required evidence | Result |
|---|---|---|
| Public homepage | desktop and phone browser render published content; navigation/focus/layout work | PENDING |
| Published revision | homepage and `/api/content` show the intended live revision | PENDING |
| Admin login | anonymous deep link redirects; good login works; bad login is generic; logout invalidates | PENDING |
| Media | thumbnail appears after upload; deletion removes it; no broken reference | PENDING |
| Booking | public flow confirms the chosen slot once and preserves the reference | PENDING |
| Admin calendar/mutation | booking appears at the correct Paris time; update is visible; cancel is authoritative | PENDING |
| Confirmation e-mail | authorized cron tick succeeds and the approved mailbox receives one message with the reference | PENDING |
| Cancellation e-mail | approved mailbox receives one cancellation for the same reference; no duplicate lifecycle | PENDING |
| Cleanup | media absent, booking cancelled, session logged out, no debt record remains, no other record changed | PENDING |

If the harness aborts, the automatic compensation runs first; only what it could not
verify lands in the cleanup-debt record (0600, path printed by the run). Resolve it
with `--cleanup` before any new state-changing run; the booking is cancelled through
the admin surface — never by deleting database rows — so history and notifications
stay authoritative.

ESZ-086 is accepted only when every row above is evidenced on the deployed target.
Until then Stage 8/9 and the e-mail portion remain **LIVE-PENDING**, regardless of a
green local validation.
