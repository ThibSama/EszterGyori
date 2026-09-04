# Production acceptance (ESZ-086)

Status: **prepared, not accepted**. This procedure has not been run against a
deployed target. Running repository tests or the read-only mode does not close
ESZ-086.

## Authorization boundary

The harness needs an explicit HTTPS origin even for read-only checks:

```sh
ESZTER_ACCEPTANCE_TARGET_URL=https://<DEPLOYED-ORIGIN>/ npm run acceptance:production
```

Read-only mode runs the project readiness probe (`scripts/readiness.mjs`,
ESZ-127/AUD-22) against the origin: `/api/health` (liveness under its frozen
contract), the homepage bootstrap, the published `/api/content` envelope, and
`/api/booking/services` reaching at least one active bookable service — the
surface that would fail if MySQL/booking were unavailable while the service
stayed live. It cannot log in, upload, book, mutate or cancel.

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

## What the automated pass does

It uses the production HTTP surface, in order:

1. Readiness probe (read-only): health = liveness under its contract, exported
   public page, published envelope, at least one active bookable service.
2. Anonymous session, CSRF-bound login and rotated authenticated session.
3. Upload a generated PNG named with an `ESZ-086-<timestamp>-<random>` marker,
   assert its server id, then delete it immediately.
4. Read active services and authoritative availability, choose the first slot in
   days 2–60, and create one marker-named booking for the approved mailbox.
5. Find that exact reference through the admin booking query/calendar surface,
   update its note, then cancel it with the marker as the cleanup reason.
6. Log out. The booking remains as a cancelled audit record by design; the media
   is removed. On failure the script prints the exact id/reference needing manual
   cleanup.

The create and cancel operations enqueue the essential confirmation and cancellation
e-mail lifecycle. The harness cannot honestly claim delivery: there is intentionally
no public queue-inspection API, and cron/SMTP/mailbox receipt are deployment-owned.

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
| Cleanup | media absent, booking cancelled, session logged out, no other record changed | PENDING |

If the harness aborts, use the printed marker, media id or booking reference to
finish cleanup before rerunning. Never delete database rows manually: cancel through
the admin surface so history and notifications stay authoritative.

ESZ-086 is accepted only when every row above is evidenced on the deployed target.
Until then Stage 8/9 and the e-mail portion remain **LIVE-PENDING**, regardless of a
green local validation.
