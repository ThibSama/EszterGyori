# Package 8.3 closure report

Date: 2026-08-21. Baseline: `master` at `b026572`, four local commits ahead of
`origin/master`, with the existing Package 8.2 dirty tree preserved. No commit,
push, deploy, external service mutation or destructive Git action was performed.

## Step 0 — ESZ-084 dependency audit

The earlier live-only classification was corrected. `npm run
security:dependencies` is now Stage 1 of the validation pipeline and checks every
lock against the authoritative online registries in both complete and production
modes.

Recorded tools: Node v24.18.0, npm 11.16.0, Composer 2.9.5, PHP 8.5.4.

| Set | Initial | Final |
|---|---:|---:|
| Composer lock, complete | 0 | 0 |
| Composer lock, `--no-dev` | 0 | 0 |
| contracts npm lock, complete / production | 0 / 0 | 0 / 0 |
| front npm lock, production | 4 high package findings | 0 |
| front npm lock, complete | 6 high package findings | 0 |

The Next server paths are not deployed—the production artifact is a static export
plus PHP with no Node runtime—but the affected graph is still a trusted build input.
The applicable P1s were fixed without a major upgrade: Next.js and
`eslint-config-next` 16.2.9 → 16.3.2, their Next/SWC/Sharp/PostCSS graph, Nanoid
3.3.12 → 3.3.18, Brace Expansion 1.1.15/5.0.6 → 1.1.18/5.0.9 and js-yaml 4.2.0 →
4.3.1. The Composer lock did not move. Final complete and production audits contain
no advisory, so there is no residual P0/P1 or lower-risk waiver.

## ESZ-086 — production acceptance harness

Status: **prepared; LIVE-PENDING; not accepted**.

`npm run acceptance:production` requires an explicit HTTPS target. Without the
exact `--live-confirmation=I_AUTHORIZE_ESZTER_LIVE_MUTATIONS` value it performs only
homepage, health and published-content reads. Full mode also requires admin
credentials and an approved customer mailbox through environment variables. It
uses an isolated marker, uploads/deletes its own media, creates/queries/updates and
cancels its own booking, logs any cleanup id/reference after failure, and never
claims that an enqueued e-mail was received. The procedure and evidence worksheet
are in `docs/production-acceptance.md`.

Acceptance still requires an authorized run on the deployed target, browser
evidence at phone/tablet/desktop widths, one successful real cron tick, and exactly
one confirmation and cancellation in the approved mailbox.

## ESZ-087 — booking concurrency

Status: **accepted locally against disposable MySQL**.

Two independent PHP processes boot the same Kernel path as `public/api/index.php`
with separate clients/connections and concurrently send the same valid slot to
`POST /api/bookings`. A parent transaction holds the production serialization row
until both processes are waiting. The proof asserts exactly:

- one `201` confirmed response and one `409 SLOT_UNAVAILABLE` envelope;
- one confirmed booking at the requested service/instant;
- one `created/public` history event;
- one pending e-mail confirmation and one pending e-mail reminder, with two unique
  idempotency keys and no second lifecycle.

The focused run passed 16 assertions; the same test is part of `sql:integration`.

## ESZ-090 — Eszter guide

Status: **accepted as repository documentation**.

`docs/eszter-operator-guide.md` covers login, draft/save/publish/reset, media,
reservation lookup/update/move/cancel, weekly hours, dated exceptions, notification
behavior, backups/restores and incident actions for e-mail, cron, booking and site
failures. It contains no secret. SMS is explicitly post-V1 (ESZ-075–079 and
ESZ-088/089).

## Validation and artifact

Full `npm run validate` ran against disposable MySQL 8.4 and reported **33 PASS, 0
FAIL, 5 NOT RUN**. Every SQL gate executed: migrations, integration (including
ESZ-087), rate limits, backup/restore and notifications. The remaining NOT RUN
gates are `smoke:http`, `browser:public`, `browser:admin`, `browser:booking` and
`security:config`; all require a deployed origin and/or real browser. The production
artifact was rebuilt and verified as a deterministic static/PHP artifact with the
production Composer set and no Node runtime.

The disposable container/database is removed after validation.

## Exact release checkpoints still open

- **Phases 3/5/6 browser proof:** on the deployed origin, public published-content
  rendering/navigation/responsiveness; admin redirect/login/draft/publish/media and
  server-side logout; public booking persistence, admin calendar and move/cancel;
  weekly hours and date exceptions composed in a real browser.
- **ESZ-082:** approved production SMTP credentials and recipient; production cron
  configured exclusive/every minute with absolute paths; a manual and scheduled tick
  proven from logs; confirmation/reminder/move/cancel delivery and mailbox receipt.
- **ESZ-086:** execute the authorized harness and complete every row of its browser
  and mailbox worksheet, including cleanup.
- **Stage 8 `smoke:http`:** Apache rewrite/AllowOverride behavior, HTTPS redirect,
  ETag/304, JSON API 404/405, populated homepage and deep-link routing on the host.
- **Stage 10 `security:config`:** private-path denial, directory indexing off, no PHP
  execution under media, live CSP/Permissions-Policy/HSTS/baseline headers, cookie
  flags and configuration ownership/mode `0600`.
- **Phase 8 closure:** all five current NOT RUN gates must execute and pass, a live
  backup must be restored into a scratch target, and ESZ-082/086 evidence must be
  recorded. Local green gates alone do not accept the phase.

SMS remains outside V1 and is not a Phase 8 blocker.
