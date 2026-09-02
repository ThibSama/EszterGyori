# ESZ-004 — Hetzner target architecture

The production topology for Eszter on **Hetzner webhosting**: a static frontend, a
same-origin PHP API under `/api`, JSON editorial content, SQL for operational state.

This document is the production **target**. Nothing here is deployed. Package 8.1
now produces and verifies the target filesystem locally; live Apache, SMTP and cron
acceptance remain deployment-owned. Section 1 distinguishes those states.

Package 1.1 (ESZ-010/011/012) built the PHP *foundation* — bootstrap, routing,
contract-driven validation and atomic JSON storage — under `php/`. Package 1.2
(ESZ-013/014/015) added the frozen public surface, proved it against the whole HTTP
contract, and retired the Express service, making `php/` the only backend.

Package 2.1 (ESZ-020/021/022) removed the last production Node runtime. The frontend is
a static export, `/` is served by PHP with the published content injected into it, and
the document-root routing is generated from a tested table.

Package 2.2 (ESZ-023/024/025/026/027) built the authorisation §6 asks for, and the parts
of §8 and §9 it rests on: a PDO layer with ordered, repeat-safe migrations; the
`admin_accounts` and `admin_sessions` schema; an explicit provisioning CLI; server-side
sessions with CSRF; and the production configuration boundaries that refuse to boot on an
unsafe setting. **§5, §6, §9 and §12 are built. §8 now includes Package 4.3's booking
API domain** — booking services, weekly rules, replacing date exceptions, bounded
dynamic slot computation, atomic public creation, guarded admin mutations and durable
history exist. Package 5.1 adds the complete public selection, customer review,
submission and confirmation flow. Packages 7.1/7.2 add the notification table,
single cron runner, booking e-mail producers and production Symfony Mailer SMTP.
Package 8.1 adds a deterministic deployment artifact and the operator runbook; backup
automation, live-host acceptance and login throttling remain outside that package.

Companion documents:

- `docs/runtime-inventory.md` — ESZ-001, the `current → target` responsibility inventory.
- `docs/contract-freeze.md` — ESZ-002/ESZ-003, the frozen HTTP surface and the
  language-neutral contract artifacts a PHP implementation must consume.
- `docs/v1-quality-gates.md` — ESZ-005, the validation policy that proves this
  architecture once it exists.
- `docs/backend-target-architecture.md` — the earlier Node/Docker direction, now
  superseded for production hosting (see §12).

---

## 1. Current executable state (not the target)

Everything below runs today and is covered by passing gates:

| Component | State |
| --- | --- |
| `contracts/` | TypeScript + Zod source of truth; generated JSON Schema, semantic rules, parity corpus and HTTP contract committed under `contracts/generated/`. |
| `front/` | Next.js 16 app, built with `output: "export"`. Every route is `○ (Static)`; there is no middleware, no route handler and no server-only dependency. Since Package 3.2 the editor loads and writes the **server** draft through `/api/admin/content/*`, signs in through `/api/auth/login`, and keeps `localStorage` only as an explicit backup the admin has to ask for. Gate `front:export` asserts all of it. |
| `php/` | PHP 8.2+ backend, and since ESZ-015 the **only** one. It owns the HTTP/API, content, media, booking and admin domains. Packages 7.1/7.2 add the durable notification queue, one lease-safe cron tick, typed booking templates and Symfony Mailer SMTP. Production refuses the development logging transport. |
| SQL | `php/migrations/` — ordered, forward-only, individually idempotent files applied by `php/bin/migrate.php` and recorded in `schema_migrations` with their checksums. Package 4.1 adds `booking_services`, rule-driven availability, `bookings` and `system_settings`; there is deliberately no future-slot table. Gates `sql:migrations` and `sql:integration` run against a disposable MySQL when `ESZTER_TEST_DB_DSN` names one, and report NOT RUN otherwise. |
| Admin identity | `php/bin/provision-admin.php`. Accounts are created by an operator, never by a migration and never at boot: a seeded default account would be identical on every deployment. The password is read from a terminal with echo off or from stdin, never from an argument. |
| Routing | `php/public/.htaccess` and `php/public/media/.htaccess`, **generated** from `src/Deploy/DocumentRootRouting.php` and drift-checked by `php:routing`. Not deployed, and not yet executed by a real Apache — see §14. |
| Deployment | `npm run package:production` creates a deterministic, manifest-verified archive with the exact `public_html`/private sibling layout, static export, production Composer set, generated contracts, runtime CLIs and migrations. `docs/deployment-runbook.md` is the operator procedure. No host/domain/TLS/cron/SMTP deployment or live smoke has been performed. |

Both of the migrations this section used to list as owed are now done, and it is worth
recording what each cost:

- `/admin`, `/admin/login`, `/admin/preview` and `/admin/auth/*` were `ƒ (Dynamic)`
  behind a `ƒ Proxy (Middleware)`. They are all `○ (Static)` now. The middleware,
  the two auth route handlers and `app/lib/auth/*` were **deleted, not ported** —
  §6 explains why a static host cannot have a replacement for them, and why
  re-creating the check in the browser would be worse than having none.
- The public route was `○ (Static)` with `Revalidate 1m`. ISR is gone with the Node
  server; `must-revalidate` plus the published ETag replaces it, exactly as §5
  specified.

Authorisation was the largest gap in this document and is no longer open. `/admin` is
still a static file reachable by anyone who knows the path — that is unavoidable and
harmless, because it holds no secrets and enforces nothing. What changed is that the
endpoints it will call are now guarded on the server: `/api/auth/*` exists, a session is
an opaque id naming a row in MySQL, and every privileged decision is made by PHP per
request (§6).

What remains owed, in the order it matters:

- **Login throttling.** §6 asks for rate-limited attempts keyed by account and by source
  address. Not built. Everything else §6 specifies is.
- ~~**The browser half of `/admin`.**~~ Built (Package 3.2). `/admin/login` posts to
  `/api/auth/login`, the editor reads and writes the server draft, and publish and reset
  call their endpoints rather than re-implementing them. Still unproven *in a browser*:
  `browser:admin` needs a deployed origin and a runner (§14).
- **Live deployment acceptance.** The artifact and procedures are built locally, but
  `smoke:http`, `browser:*` and the live portion of `security:config` remain NOT RUN;
  no `.htaccess`, SMTP account or cron entry has been exercised on real hosting (§14).

---

## 2. Topology

```text
                    ┌──────────────────────────────────────────────┐
   browser ──HTTPS──▶ Hetzner webhosting (Apache + PHP-FPM)        │
                    │                                              │
                    │  /            ─▶ static HTML/CSS/JS (Next     │
                    │                   export) + PHP content       │
                    │                   injection (§5)              │
                    │  /admin/*     ─▶ static admin shell (§6)      │
                    │  /api/*       ─▶ PHP front controller         │
                    │  /media/*     ─▶ static files, served direct  │
                    └───────┬──────────────────────────────────────┘
                            │ (all below the document root)
              ┌─────────────┼──────────────────┬────────────────────┐
              ▼             ▼                  ▼                    ▼
        app/ (PHP)    data/ (JSON +      MySQL (admin,        config/ (secrets)
                      media originals)   booking, settings,
                                         notifications)
                            ▲
                            │ notification cron ──▶ job dispatcher ──▶ SMTP
```

Single origin. No CORS anywhere, no preflight, no cross-site cookie problem: the
frontend and the API are the same host and scheme.

**Node is a build-time toolchain only.** It never runs on the Hetzner host. This is a
hard constraint, restated from `docs/runtime-inventory.md` §8, and every decision below
respects it.

SMS is deferred post-V1 and is not a production dependency of this layout.

---

## 3. Filesystem layout: public root vs private paths

Hetzner webhosting serves a single directory per domain. Exact names are account-level
and must be confirmed against the plan before Phase 1 (`public_html` is assumed here);
the **structure** is what matters and does not depend on the name.

```text
$HOME/
├── public_html/               ← DOCUMENT ROOT — the only web-reachable directory
│   ├── index.html             ← Next static export
│   ├── _next/                 ← hashed build assets, immutable
│   ├── admin/                 ← admin shell (static)
│   ├── media/                 ← published derivatives only (§7)
│   ├── api/index.php          ← the ONLY PHP file under the document root
│   └── .htaccess              ← routing + hardening
├── app/                       ← PHP source, vendor/, templates. NOT web-reachable
├── config/                    ← secrets and environment config (§9)
├── data/
│   ├── content/               ← draft.json, published.json, media-library.json (§4, §7)
│   ├── media-originals/       ← uploaded originals + .intake/, never served (§7)
│   └── locks/                 ← advisory lock files (§4, §7, §8)
├── var/
│   ├── log/                   ← application + cron logs
│   └── tmp/                   ← atomic-write staging (same filesystem as data/)
└── backups/                   ← local retention tier (§10)
```

Rules:

1. **One PHP entry point under the document root**: `public_html/api/index.php`. It
   bootstraps from `../../app/`. Nothing else executable is web-reachable.
2. `app/`, `config/`, `data/`, `var/`, `backups/` are **siblings of** the document
   root, not children. Path traversal is the only way to reach them, and that is a
   bug, not a configuration option.
3. If the hosting plan cannot place the document root below `$HOME`, these directories
   move inside it and are additionally denied by `.htaccess` — **defence in depth, not
   a substitute**. This case must be confirmed, not assumed.
4. `var/tmp/` is on the same filesystem as `data/` so that `rename()` stays atomic.
   This is a correctness requirement, not tidiness (`docs/runtime-inventory.md` 4.2).

### Web server hardening (`.htaccess`)

- Deny access to `*.json`, `*.md`, `*.log`, `.git`, `.env*`, `composer.*` anywhere
  under the document root.
- Disable directory indexing (`Options -Indexes`).
- Disable PHP execution under `media/` — an upload that lands there must be inert —
  and whitelist the names it may serve at all (§7).
- Suppress `X-Powered-By` / `Server` banners (`docs/runtime-inventory.md` 1.6).
- Force HTTPS and set HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  and a CSP that permits only same-origin scripts.

---

## 4. Editorial content: JSON, not SQL

Editorial content stays in **JSON files**, exactly as today. It is not moved into MySQL.

| Property | Decision |
| --- | --- |
| Location | `data/content/draft.json`, `data/content/published.json` |
| Shape | The frozen envelope. Validated against `contracts/generated/*.schema.json` **plus** every rule in `semantic-rules.json`. |
| Write | Temp file in `var/tmp/` → `fsync` → `rename()` into `data/content/`. Never a partial file visible to a reader. |
| Concurrency | `flock()` on `data/locks/content.lock`, held for the whole read-modify-write. This closes open question 1 of `docs/runtime-inventory.md` §12. |
| Size cap | 1 MB, ported from `MAX_CONTENT_FILE_BYTES`, checked before the file is read. |
| Seeding | Idempotent. A missing file is seeded from the canonical defaults; an existing file is **validated, never overwritten**. A file that exists but cannot be validated aborts the boot rather than being replaced (Package 1.1, strict fail-fast). |
| Revision | **One sequence, shared by both files** (frozen in Package 3.1 as `contentRevisionSemantics`). `draft.revision` is the head and moves on every draft write; `published.revision` is set *to* the draft head that was published, so it is not a count of publishes; `published.revision <= draft.revision` always. Non-negotiable: `revision` is the sole input to the `"published-<revision>"` ETag. |

**Why JSON and not SQL.** The content document is a single versioned artifact that is
read whole, written whole, and already has a frozen schema plus an executable parity
corpus. Normalising it into tables would discard that contract, add migration cost per
copy change, and buy nothing — there are no queries to run over it. SQL earns its place
where there *are* queries (§8).

**Rejected alternative:** content in MySQL with JSON columns. It reintroduces the
drift risk ESZ-003 exists to eliminate, because the schema would then live in two
places.

### Draft vs published

The lifecycle from `docs/backend-target-architecture.md` is unchanged and binding:

```text
canonical defaults ─seed/fallback─▶ server draft ─explicit publish─▶ published content
```

Saving a draft must not alter the public site. Publishing is an explicit, validated
copy that moves `published.revision` up to the draft head it published.

> **Built (Packages 3.1 and 3.2).** `data/content/draft.json` is written behind
> authentication through `/api/admin/content/*`, which is what makes the CMS usable
> from more than one device, and since Package 3.2 the browser editor is the client of
> those routes: it loads the draft on entry, saves with the `expectedRevision` it was
> handed, and treats a 409 as a conflict to *reconcile* rather than a write to retry: it
> backs the local draft up, re-reads the server draft's content, merges the two three-way
> against the base it loaded, and writes only a clean merge — once. A revision becomes
> authoritative only from an envelope that carried its content, never from the header on
> a refusal.
> `localStorage` keeps one job, explicit backup, and is never read on load.
>
> One clarification the original sentence left open: it described publishing as
> "revision-bumping", which is true of the *published* file's value and would be
> misleading as a rule. Publishing does not increment a counter — it copies the draft
> head across — so republishing an unchanged draft is idempotent and invalidates no
> cache, while a publish that actually advances the site always retires the previous
> ETag. `contentRevisionSemantics` carries the full reasoning.

---

## 5. The public site: static export with PHP content injection

> **Built (ESZ-020/021).** `front/next.config.ts` sets `output: "export"`;
> `PublicPageEndpoint` and `PublicPageBootstrap` implement the injection; gates
> `front:export`, `php:public-page` and `php:http-contract` cover it. Two details of
> the design below were decided during implementation and are recorded after the
> section.

The frontend is built with `next build` using `output: "export"`, producing
`front/out/` (already gitignored). No Node runs in production.

This creates one real problem. A static export bakes content at **build** time, but the
whole point of the CMS is that Eszter changes content **without** a rebuild — and there
is no Node on the host to rebuild with.

### Decision

`/` is served by PHP, which streams the exported `index.html` and injects the current
published content into a single placeholder before sending it.

```text
public_html/index.html          ← export, containing:
    <script id="__ESZTER_CONTENT__" type="application/json">{…}</script>
    <style id="__ESZTER_APPEARANCE__">:root{--…}</style>

GET /  ─▶ api/index.php (route: public page)
          ├─ read data/content/published.json  (validate before serving)
          ├─ replace the two placeholder blocks
          ├─ ETag: "published-<revision>"  /  Cache-Control: public, max-age=0, must-revalidate
          └─ honour If-None-Match ─▶ 304, empty body
```

Properties this preserves:

- Fully populated HTML on first byte — the marketing site keeps its SEO and LCP.
- Content changes are live on publish, with no rebuild and no Node.
- The caching semantics are **the same frozen ones** as `GET /api/content`: same ETag
  format, same `Cache-Control`, same `If-None-Match` handling. One implementation,
  used twice.
- A storage or validation failure degrades to the baked-in canonical defaults, mirroring
  the typed fallback the frontend already implements (`docs/runtime-inventory.md` 10.4).
  The site must never render an error page because content is unreadable.

Injection must be JSON-encoded with `JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS |
JSON_HEX_QUOT` so that no editorial string can terminate the `<script>` element. The
appearance block emits **only** CSS custom properties whose values passed
`hexColorSchema`; nothing else from the document reaches CSS.

### Rejected alternatives

| Option | Why not |
| --- | --- |
| Client-side fetch of `/api/content` into an empty shell | Blank first paint, content invisible to crawlers. Unacceptable for a marketing site. |
| Rebuild and re-upload on every publish | Requires Node in the deploy path and makes the CMS not self-service. Directly violates the build-only constraint. |
| Full PHP templating of the public page | Duplicates the React component tree in PHP. Two renderers to keep in sync, for no gain. |

### Two decisions this section did not anticipate

**The baked HTML carries the *defaults*, not the published copy.** A static export can
only bake what existed at build time. So the exported `index.html` contains the
canonical French copy, and PHP swaps in the published document at request time. A
crawler and the first paint therefore see real, indexable content — which is what this
section actually required — but if published copy has diverged from the last build,
React reconciles the difference after hydration.

That reconciliation is done with `useSyncExternalStore`, whose `getServerSnapshot`
returns the defaults and whose `getSnapshot` returns the injected document. It is
React's sanctioned way to say "the server markup and the client data differ, on
purpose". Hydrating straight from the injected payload would be a hydration mismatch,
which React 19 recovers from by discarding the server markup and client-rendering the
whole tree — an error in the console and the slow path on the one page whose LCP
matters.

**Appearance moved out of JavaScript so PHP would not have to reimplement it.** This
section requires the injected `<style>` to contain only values that passed
`hexColorSchema`. The frontend used to *compute* each section's background with
`mixHexColors(background, tint, ratio)`, which would have forced PHP to reproduce a
colour-blending formula to inject anything — presentation logic in two languages, which
§5's own rejected-alternatives table exists to avoid.

The blending moved into `globals.css` as `color-mix(in srgb, …)`, the same gamma-space
sRGB interpolation at the same ratios. PHP now only ever copies validated hex, plus one
contract-defined contrast choice (`--site-primary-contrast`, the contract's own
`getReadableForeground` rule, ported into `Eszter\Contract\Appearance` alongside the
contrast maths that was already there). The list of properties, their order and their
sources are generated into `http-contract.json`, so the export and the injector are
driven by one declaration rather than two lists kept in step by hand.

### ISR replacement

`next.revalidate = 60` disappears with the Node server. It is replaced by
`must-revalidate` + ETag: every request revalidates cheaply, and a revision bump is
what makes new content visible. This closes disposition 10.3 of the runtime inventory.
`CONTENT_API_URL` becomes unnecessary for the public page — the content is read from
disk, same host, no HTTP hop.

---

## 6. The admin area

> **Half built (ESZ-020).** The shell is static and exported. The Next middleware gate
> is gone, and **nothing replaced it** — `/admin` is not access-controlled. Everything
> in the "Target" column below is Package 2.2's, and — apart from the last row, which
> belongs to a later package — it is now what is built. The "Today" column is kept as
> the record of what was replaced, because the *reason* each replacement was necessary
> is the most reusable thing in this section.

The admin is a **static shell** under `public_html/admin/`, driven entirely by
`/api/admin/*`. It renders no secrets at build time.

The current Next.js middleware gate (`front/proxy.ts`) **cannot come along**. A static
host has no middleware, and a client-side redirect is not access control. This is the
single most important correction in this document.

| Concern | Today | Target |
| --- | --- | --- |
| Route protection | `front/proxy.ts` middleware | **PHP**, enforced per request on every `/api/admin/*` call. The shell may redirect for UX; the API is the authority. |
| Session | JWT HS256 cookie signed by Next (`jose`) | **Built (ESZ-025).** Opaque 256-bit random id, server-side record in `admin_sessions`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, and the `__Host-` name prefix so the browser enforces the last three itself. Two deadlines: an idle timeout that slides forward, and an absolute ceiling that never does. The id rotates on login and the pre-login row is deleted; logout deletes the row **before** expiring the cookie, so a replayed cookie names nothing. |
| Password | scrypt via `node:crypto` | **Built (ESZ-024).** `password_hash()` / `password_verify()` with `PASSWORD_DEFAULT` — Argon2id where the build has it, bcrypt otherwise — re-hashed on sign-in when the default moves. Unknown address, wrong password and disabled account answer one identical 401, and all three perform a verification so their *timing* does not separate them either. |
| CSRF | Origin + `Sec-Fetch-Site` check only | **Built (ESZ-026).** A 256-bit per-session token, required in `X-CSRF-Token` on every state-changing request and compared with `hash_equals`. Bound to the *anonymous* session too, which is what lets `POST /api/auth/login` be protected — login CSRF, where a victim is silently signed into an attacker's account and everything they then write lands in it, is a real attack on an editing surface. The token is re-minted whenever the session id rotates. `SameSite=Strict` is required in addition, never instead: it is a browser behaviour, not a server check, it does nothing for a non-browser client, and a same-site subresource sails through it. |
| Draft storage | browser `localStorage` | **Built (Packages 3.1 and 3.2).** `draft.json` behind authentication, read and replaced through `/api/admin/content/draft`, published explicitly through `…/publish` and rebuilt from published content through `…/reset`. The browser editor calls those routes and holds no authority of its own; `localStorage` survives only as an explicit backup and as the export/import format, never as the source of truth and never auto-applied over server state. |

Restated from `docs/runtime-inventory.md` §6: **the frontend session must never be
treated as authorization for a PHP endpoint.** With the middleware gone, PHP-side
enforcement is not a defence-in-depth nicety — it is the only thing standing there.

Additional hardening: rate-limit and throttle login attempts (counter in SQL, keyed by
account and by source address), with a uniform failure response and no user enumeration.
**Not built.** The uniform failure response and the absence of enumeration *are* built
and covered (`auth.failureModesAreIndistinguishable`); the counter and the throttle are
not, and there is no `login_attempts` table. This is the one item in this section
Package 2.2 left open, and it is deliberately not half-built: a counter with no
enforcement would read like a control while being none.

### API surface

The frozen public surface (`GET /api/health`, `GET /api/content`) is implemented exactly
as specified in `docs/contract-freeze.md`, including the 404/405 envelopes. The routes
listed as *not implemented* there — `/api/admin/content/*`, `/api/admin/media`,
`/api/auth/*` — are built in Phase 1 and **must be added to `contracts/http-contract.ts`
first**, so the contract stays the source of truth rather than a description written
afterwards.

As of Package 3.1 the two public routes, `/`, the three `/api/auth/*` routes and the
three `/api/admin/content/*` paths are implemented and replay the whole contract (gate
`php:http-contract`). Both authenticated families were added to
`contracts/http-contract.ts` **before** any PHP was written for them, which is what this
paragraph asks for; the artifacts were regenerated and the drift gate
(`contracts:verify:generated`) is what proves the committed copies match.
As of Package 3.3 the media surface joined them: `GET|POST|DELETE /api/admin/media`
were added to `contracts/http-contract.ts` before any PHP was written for them, and
no `/api` path is frozen at 404 any more. The one planned
change to the surface has been applied: `/api/health` no longer carries `uptimeSeconds`,
because shared-hosting PHP has no process to measure. See `docs/contract-freeze.md`,
Part 4.

---

## 7. Media

> **Built (ESZ-036 / ESZ-037).** `GET|POST|DELETE /api/admin/media` are frozen in
> `contracts/http-contract.ts` under `media` and implemented in `php/src/Media/`.
> Gate `php:media` runs the whole pipeline against real image bytes; `php:routing`
> executes the `media/` whitelist. What is still unproven is Apache applying that
> whitelist — `smoke:http` and `security:config`.

| Stage | Location | Served? |
| --- | --- | --- |
| Upload target | `data/media-originals/.intake/` | No |
| Original | `data/media-originals/` | **No** |
| Catalogue | `data/content/media-library.json` | No |
| Published derivative | `public_html/media/` | Yes, directly by Apache |

Two changes from what this section originally specified, both made while building
it and both worth reading as corrections rather than as details:

- **Intake moved from `var/tmp/` into the originals directory.** The intake file
  is renamed into place as the original once it verifies, and `rename()` is only
  atomic within one filesystem. Staging it inside the directory it graduates into
  makes that true by construction instead of by a configuration rule someone has
  to get right. The derivative is staged the same way, inside `public_html/media/`,
  which is safe because of the whitelist below.
- **The content document references media by *path*, not by id.** `MediaAsset.src`
  holds a public path — that is what the content schema accepts and what the page
  renders — so the path is what a document can be said to reference. An id→path
  mapping would mean parsing an id back out of every `src`, and a spelling the
  parser did not recognise would read as "not referenced", which is the one wrong
  answer that loses data.

Rules:

- Accept an explicit allowlist of image types, verified by **content inspection**,
  never by client-supplied extension or MIME type. V1 is JPEG, PNG and WebP.
  **No SVG**: an SVG is a scriptable document, and serving one from the origin
  that holds the admin session is a stored-XSS primitive. No GIF, no AVIF.
- Verify with **two independent parsers** — `finfo` on magic bytes and
  `getimagesize()` on the image header — and require them to agree. A file that
  answers them differently is a polyglot and is refused rather than resolved.
- Bound the **decoded** dimensions from the header *before* decoding. A 40 kB PNG
  can declare a 30 GB bitmap, and a byte limit alone does not bound memory.
- Detect truncation from the bytes, by requiring the format's end-of-stream
  marker. Decoders cannot be asked: libjpeg's error recovery turns a JPEG cut off
  mid-transfer into a complete image with grey filler and reports nothing.
- Store under a cryptographically random generated id; never reuse the client
  filename on disk. The extension is derived from the verified type, so a filename
  can express no extension at all.
- Re-encode on ingest. This strips EXIF (including GPS) and any appended payload
  as a consequence of how it works, rather than as a separate step someone can
  forget.
- Serve derivatives with a long-lived immutable cache header. The id is minted
  once and never reused, and the ingest never rewrites a published file, so
  replacing an image means a new id and a new URL.
- PHP execution disabled under `media/` at the web-server level (§3), **and** a
  whitelist: `media/.htaccess` denies every name that is not
  `med_<32 hex>.<jpg|png|webp>`. A deny-list of extensions can always be got past
  by a spelling it forgot; a whitelist cannot, and it is also what makes staging a
  derivative inside the served directory harmless.
- Deleting a referenced asset must fail, not orphan the reference — and the check
  covers **both** the authoritative draft and the published document. An image
  removed from the draft is still on the live site until someone publishes.
- Nothing is ever deleted implicitly. Repointing a `MediaAsset.src` leaves the
  previous asset in the library; reference-counting on save is how one mistaken
  edit becomes unrecoverable.
- Media is not stored in SQL. The catalogue is a JSON file written through the
  same atomic temp-write/fsync/rename as `draft.json`; bytes stay on disk.

### Hosting requirements

The upload route needs PHP configured for it. These are deployment settings, not
code, and the front controller cannot raise them from inside a request:

| Setting | Minimum | Why |
| --- | --- | --- |
| `file_uploads` | `On` | Off means `$_FILES` is always empty. |
| `upload_max_filesize` | `8M` | The frozen per-file limit. Below it, PHP refuses the file itself with `UPLOAD_ERR_INI_SIZE` and the route answers 413. |
| `post_max_size` | `10M` | Must exceed `upload_max_filesize` plus multipart framing. **Below the body size, PHP discards the body silently** — empty `$_POST`, empty `$_FILES`, no error code. The route detects that case from the declared `Content-Length` and answers 413 rather than "no file attached", but the honest fix is the setting. |
| `memory_limit` | `256M` | An 8000 × 5000 truecolour bitmap is ~160 MB in decoded pixels alone; the pixel cap (40 MP) is what actually bounds this, and the limit must also leave room for GD and PHP overhead. |
| `max_execution_time` | `30` | Decode plus re-encode of a 24 MP JPEG. |
| `extension=gd` | required, **with JPEG, PNG and WebP** | Decoding and re-encoding. A `gd` built without WebP is loaded, present, and silently unable to verify a third of the allowlist. |
| `extension=fileinfo` | required | Typing an upload from its bytes. |

A deployment missing `gd` or `fileinfo`, or missing a format the allowlist
declares, answers **500 `INVALID_CONFIGURATION`** on upload and stores nothing.
That is deliberate: every step of the pipeline exists because the ones before it
are insufficient, so an ingest that skipped the decode because no decoder was
installed would be accepting whatever the caller sent on the strength of its
magic bytes alone. `imagick` is *not* required and is not used.

`config.php` gains one key: `paths.mediaOriginals`, a sibling of the document
root. It is required rather than derived, because the one directory that must
stay unreachable should not depend on the shape of a path someone else configured.

---

## 8. SQL: operational state

MySQL owns everything the JSON content document deliberately does not: state that is
queried, filtered by date, or appended to over time.

Admin, the booking foundation and the notification queue are built. Settings has its
first key as of Package 7.1.

| Domain | Owns | State |
| --- | --- | --- |
| Admin | accounts, password hashes, sessions, login attempts, audit log of publishes | **Built**, except login attempts (§6) and the publish audit log (no publish endpoint yet). |
| Booking | service configuration, availability rules/exceptions, appointment facts, contact details, consent and explicit state transitions | **Backend/API built (Package 4.3).** Public/admin UI remains unbuilt. |
| Settings | operational configuration editable at runtime — **not** secrets, **not** editorial copy | Table built empty in Package 4.1; `notifications.channels` is its first key (Package 7.1). |
| Notifications | outbound queue: booking relation, channel, type, due and next-attempt UTC instants, status, attempts, bounded diagnostic code, delivery instant, durable lease and caller-supplied idempotency key | **Built through Package 7.2.** Queue/leases/retries/catch-up plus atomic booking e-mail producers and configurable Symfony Mailer SMTP are done. SMS remains unimplemented. |

Boundaries:

- **Editorial copy never enters SQL** (§4). **Secrets never enter SQL** (§9).
- Every schema change is a numbered, forward-only migration file, applied by a script,
  recorded in a `schema_migrations` table. No hand-edited production schema, ever.
  Implemented as `php/migrations/NNNN_name.sql` plus `php/bin/migrate.php`. Editing a
  file that has already been applied is refused on its recorded checksum, and a database
  recording a version this checkout does not contain is refused as a schema that has run
  ahead of its code.
- **Every migration is individually idempotent, and this is enforced.** MySQL commits
  implicitly before and after every DDL statement, so a migration is not atomic and
  cannot be made atomic — a file with three `CREATE TABLE`s that dies on the third
  leaves two tables behind and no row in `schema_migrations`. Wrapping it in
  `BEGIN`/`COMMIT` would not fix that, only hide it behind syntax that looks like a
  guarantee. So the guarantee lives in the files: `IF NOT EXISTS` and guarded `ALTER`s
  only, checked mechanically at read time, so a non-re-runnable statement fails on a
  developer's machine rather than half-way through a deploy.
- Concurrent deploys serialise on a named advisory lock (`GET_LOCK`); the second one
  waits and then finds nothing pending.
- `utf8mb4` / `utf8mb4_unicode_ci` throughout. The frontend already asserts that the
  canonical content is well-formed NFC UTF-8; the database must not be the component
  that breaks it.
- **Two deliberate exceptions to that collation**, both on identity columns.
  `admin_accounts.email` is `utf8mb4_bin` and `admin_sessions.id` is `ascii_bin`, because
  `utf8mb4_unicode_ci` is accent-insensitive as well as case-insensitive: under it
  `rene@…` and `renée@…` collide on the unique index, and one of two legitimate people
  could not have an account. The case folding that *should* happen happens in PHP, once,
  where the contract defines it (`auth.identity`). A session id compared
  case-insensitively would likewise match ids that are not it.
- Prepared statements only, with `ATTR_EMULATE_PREPARES` **off** so that is literally
  true rather than PHP interpolating the values itself. `ERRMODE_EXCEPTION` and
  `STRINGIFY_FETCHES=false` go with it: the defaults are silent-failure and
  everything-is-a-string respectively, and both turn a wrong result into a plausible one.
  The one place raw SQL is executed is the migration runner, through a method named so
  that grepping for it finds every caller.
- Booking rows contain personal data: define retention and deletion up front, not after
  the first request to erase.

### Package 4.1 booking policy (ESZ-040/041/042)

- `contracts/generated/booking-domain.json` is the language-neutral source consumed by
  PHP. Bookable service keys reuse the stable `SiteContent.services.items[].id` values:
  `brows`, `eyeliner`, `lips`, `freckles`. SQL stores only booking label, duration,
  buffers, active state and audit timestamps; editorial descriptions and media remain
  in SiteContent. No migration or boot path seeds rows. Provisioning is an explicit,
  repeat-safe `php/bin/provision-booking-service.php` action.
- Availability is stored as ISO weekday plus local `DATE`/`TIME` rules and one replacing
  exception per local date. Those wall-clock values are interpreted exclusively in the
  IANA zone `Europe/Paris`; PHP, MySQL and host timezone defaults are irrelevant. No
  future appointment slot is generated or persisted in Package 4.1.
- Appointment instants are converted before persistence and stored in UTC
  `DATETIME(3)` columns named `*_utc`; `timezone_name = Europe/Paris` records the policy.
  A spring-forward wall time that does not exist is rejected. A fall-back wall time that
  occurs twice requires an explicit numeric UTC offset, which must match an offset the
  IANA database reports for that local time. The application never guesses a DST fold.
- V1 has exactly `confirmed` and `cancelled`. The only transition is
  `confirmed → cancelled`; `cancelled` is terminal, and same-state transitions fail.
  Cancellation updates the row and records `cancelled_at_utc`; it never deletes it.
  `completed` and `no_show` stay absent until their actors and semantics are designed.

### Package 4.2 availability policy (ESZ-043/044/045)

- Civil times travel as `HH:MM` restricted to a real 24-hour clock. The frozen wire
  pattern `^([01][0-9]|2[0-3]):[0-5][0-9]$` accepts exactly `00:00`–`23:59`, so `24:00`
  and `09:60` are refused structurally, by every implementation, before any domain code
  runs. There is no midnight-end convention: a window ends at `23:59` at the latest and
  the next one starts at `00:00`. The range living in the wire type replaces nothing in
  the domain — increasing windows, spring-gap rejection and explicit fall-fold selection
  are unchanged, and `AvailabilityWindow` re-checks the range rather than assuming the
  schema ran.
- Weekly availability supports multiple non-overlapping local windows for each ISO
  weekday. `valid_from` and `valid_until` are nullable, inclusive bounds. Rules may
  share a weekday only when their wall-clock windows or validity ranges do not
  overlap; adjacent half-open windows are valid.
- One parent exception remains unique per local date. `closed` replaces the weekly
  result with no windows. `open` replaces it with the exception's complete ordered
  window set; the sources are never merged. Exceptional opening and partial
  unavailability therefore use the same unambiguous representation: persist every
  remaining open window for that date.
- Slots are computed in memory and never stored. Starts use a 15-minute grid aligned to
  local civil midnight. A candidate's half-open resource interval is
  `[start - bufferBefore, start + duration + bufferAfter)`; it must fit inside one
  effective window and must not overlap any non-cancelled booking expanded by that
  booking's own service buffers. Touching boundaries are allowed.
- Queries cover at most 90 inclusive local dates and may return at most 1,000 slots;
  excess is an explicit failure, never silent truncation. Results are ordered by local
  date, window and grid time.
- Every candidate is converted through `BookingTimePolicy`. Spring-gap candidates are
  omitted because their civil times do not exist. A window touching the repeated autumn
  hour must store `+01:00` or `+02:00`; the offset is checked against IANA data and is
  used only to choose that fold. No PHP, MySQL or host timezone default participates.

### Package 4.3 booking API policy (ESZ-046/047/048)

- The contract freezes `POST /api/booking/availability`, `POST /api/bookings`,
  authenticated `POST /api/admin/bookings/query`, and authenticated plus CSRF-protected
  `PATCH /api/admin/bookings`. Public failures use only the opaque error envelope and
  never expose customer, SQL, lock or validation internals.
- Availability accepts an active canonical service and a valid Paris-local range from
  today through the 90-day inclusive horizon. It delegates to `SlotEngine`, preserves
  its deterministic order and never writes generated slots.
- Creation and moves run in one SQL transaction. They lock the singleton `primary` row
  in `booking_resource_locks` with `SELECT … FOR UPDATE`, then re-read the service,
  weekly rules, date exception and all non-cancelled occupancy before recomputing the
  requested instant through `SlotEngine`. The shared row serialises conflicts across
  services and buffers; preflight availability is never trusted.
- The admin calendar discovers move candidates through authenticated
  `POST /api/admin/bookings/move-availability`. The server resolves the service from the
  opaque booking reference, delegates to `SlotEngine`, and excludes only that booking;
  the browser submits one exact returned UTC instant and never recreates availability.
- Public creation stores explicit consent facts and returns an opaque reference without
  customer data. Admin updates may change only name, email, phone and note; moves retain
  reference and service and are allowed only while confirmed; cancellation uses the
  central state transition and never deletes the booking.
- `booking_history` appends `created`, `moved`, `cancelled` and `customer_updated`
  events in the same transaction as their change. The booking row remains the source of
  truth for current state.

### Package 5.1 public booking flow (ESZ-050 through ESZ-055)

- `/reservation` is an independently exported public page. Navigation and each service
  card link to it; a `?service=<canonical-key>` hint may preselect a service only after
  the server confirms that key is active.
- `GET /api/booking/services` exposes only active canonical keys, booking labels and
  durations. The browser intersects those keys with published `SiteContent` services,
  preserving editorial titles and descriptions without copying them into SQL or the
  booking contract.
- Seven-day navigation is bounded to the API's 90-day Paris-local horizon. Dates and
  slots become selectable only from a validated `POST /api/booking/availability`
  response; the browser computes no availability. Service, date and range changes clear
  every downstream choice.
- Selection retains the complete returned slot, including its exact UTC start and fold
  offset. Refresh revalidates against returned UTC starts and clears a disappeared slot
  with a recoverable explanation.
- Name, email, optional phone/note and explicit consent are reviewed with service/date/
  slot before the browser sends the existing `POST /api/bookings` contract. The exact
  server-returned UTC start is submitted; an immediate in-memory lock and disabled
  controls prevent duplicate concurrent posts. Customer and consent facts are never
  written to browser storage.
- Only a validated successful response shows confirmation and its opaque reference. A
  last-second 409 clears the slot, retains customer input, refreshes availability and
  never retries or chooses a replacement. Network loss is described as uncertain
  because the non-idempotent request may have committed before the response was lost.

---

### Package 7.1 notification queue policy (ESZ-070/071/072)

- `notification_jobs` is the durable queue. One row per intended notification, keyed by
  a caller-supplied idempotency key that is unique across the whole table, so a repeated
  enqueue resolves to the same logical job instead of creating a second one. Enums,
  the status graph, the retry arithmetic, the lease duration, the grace window and the
  log allowlist are frozen in `booking-domain.json` under `notifications`; the
  migration's `CHECK` constraints restate the same sets where MySQL can enforce them.
- Statuses are `pending`, `processing`, `sent`, `failed` and `skipped`. The last three
  are terminal and nothing leaves them, which is what makes "delivered at most once" a
  property of the graph rather than of the runner. `processing` is reachable only from
  `pending`.
- `booking_id` references `bookings` with `ON DELETE RESTRICT`. Notification history is
  the record of what a customer was told and must not disappear with the appointment it
  describes; V1 never deletes a booking, so this refuses loudly on the day someone adds
  a delete path.
- **Claiming.** A single conditional `UPDATE` from `pending` to `processing`, guarded on
  the status and the due time, taking a durable lease (`lease_owner`,
  `lease_expires_at_utc`) and charging one attempt. InnoDB serialises two concurrent
  versions of that statement on the row lock and re-evaluates the predicate after the
  wait, so exactly one runner sees a row affected. No transaction is held across a
  transport call: the claim commits, delivery happens outside it, and the outcome is
  written as its own statement.
- **Recovery.** An expired lease returns to `pending` on the next tick without resetting
  attempts, so a job that keeps killing its runner exhausts its budget and becomes
  terminally failed instead of looping forever. Marking a job sent is guarded on the
  lease owner, so a runner whose lease expired mid-delivery cannot record a delivery it
  no longer owns.
- **Retries.** Deterministic exponential backoff — 60, 120, 240, 480 seconds, clamped at
  one hour — with a five-attempt ceiling that the schema also enforces. A transient
  failure on the last permitted attempt is terminal; a permanent transport refusal is
  terminal immediately.
- **Catch-up.** A `booking_reminder` whose due instant is more than 60 minutes old
  becomes terminally `skipped` and is never delivered. Enforced twice: swept before
  claiming, and re-checked after claiming, because a batch can cross the boundary while
  queued behind a slow transport. Non-time-sensitive types never expire.
- **No backfill, no burst.** Every intended notification produces a row, always. One
  refused because its channel is off is written immediately as terminally `skipped`, so
  re-enabling SMS months later finds nothing pending to flush; the burst is prevented at
  the moment each notification is declined rather than rate-limited afterwards. Channel
  state lives in `system_settings` under `notifications.channels` and defaults to
  email-only when the row is absent.
- **Provider neutrality.** Delivery goes through a transport interface resolved per
  channel before the run starts; a channel with no transport stops the run rather than
  burning jobs. Package 7.2 registers production SMTP for e-mail. The logging transport
  opens no socket and is restricted to development/test; no SMS transport exists.
- **Diagnostics.** The stored error column is a code matching `^[a-z][a-z0-9_]{2,63}$`,
  which cannot express an address, a phone number or a message fragment. Logging is an
  allowlist rather than a redaction filter: a field nobody listed is dropped, and an
  allowed key cannot carry an arbitrary value.

## 9. Configuration and secrets

- All secrets live in `config/`, **outside** the document root, mode `0600`, owned by
  the application user, and **never** committed. `.gitignore` already excludes `.env*`.
- Loaded by PHP at boot from a file returning a PHP array, or a parsed `.env`. Not from
  environment variables — shared hosting gives no reliable way to set them per-process.
- **Fail fast**: invalid or missing configuration aborts the request with a 500
  `INVALID_CONFIGURATION` envelope and a detailed log entry. It must never fall back to
  defaults and serve a half-configured site. This preserves today's startup behaviour
  (`docs/runtime-inventory.md` §5) in a model that has no startup.
- **Production refuses specific unsafe settings** (ESZ-027), each because the failure it
  prevents is otherwise silent: no `database` block at all; a DB password that is empty
  or is still one of the placeholders from `config.example.php`; a DSN that is not
  `mysql:` (a `sqlite:` one would run the whole admin surface against a file the next
  deploy replaces, with every test green); `session.cookieSecure: false`, without which
  the session cookie can be stripped onto plain HTTP; and a configuration file readable
  by group or others, which on shared hosting means readable by other tenants. Outside
  production none of these applies — a developer's checkout is routinely `0644`, and
  refusing to boot over that would only teach people to ignore the check when it fires
  for real.
- **Secrets never serialise.** `DatabaseSettings` redacts under `json_encode`,
  `var_dump`/`print_r` and its own `describe()`, which yields `driver:dbname` and nothing
  else. Driver error messages are scrubbed of credential-shaped fragments before they
  reach even the log. `Session` redacts its id and its CSRF token the same way, and
  `AdminAccount` redacts its hash.
- The cookie's name and its `HttpOnly`/`SameSite`/`Path` attributes are deliberately
  **not** configuration. They are frozen in `http-contract.json` under `auth`, so no
  config file can quietly relax them; only the timings and `cookieSecure` are settings.
- A committed `config/config.example.php` documents every key with placeholder values.
- Secrets inventory: DB DSN/user/password, SMTP credentials, SMS gateway credentials,
  cron shared token (§11). There is deliberately **no** admin session secret: sessions
  are opaque ids naming server-side rows, not signed tokens, so there is nothing to sign
  and therefore no signing key to leak, rotate or forget to rotate.

Node-era variables are retired: `NODE_ENV`, `HOST`, `PORT`, `CONTENT_DATA_DIR` and
`CONTENT_API_URL` have no target counterpart (`docs/runtime-inventory.md` §5). The
`ADMIN_*` variables move into `config/` and change meaning per §6.

---

## 10. Backups

Three artifacts, each with a different failure mode:

| Artifact | Method | Frequency |
| --- | --- | --- |
| MySQL | `mysqldump`, single-transaction, gzip | Daily |
| `data/content/` | Copy of `published.json` + `draft.json` | On every publish, plus daily |
| `data/media-originals/` | Incremental sync | Daily |

- Written to `backups/`, then pulled **off-host**. A backup that only exists on the
  machine it protects is not a backup.
- Retention: 7 daily, 4 weekly. Publish snapshots retained long enough to roll back a
  bad edit — that is the most likely restore this project will ever perform.
- Backups are never written under the document root.
- **A restore is rehearsed before go-live and the rehearsal is recorded.** An untested
  backup is an assumption.
- Content rollback is a first-class operation: restore a published snapshot, then
  increment `revision` so caches actually observe the change. Restoring the bytes
  without bumping the revision leaves clients on the bad version.

---

## 11. Scheduled work: one cron runner

Shared hosting allows only a small number of cron entries, so the design assumes
**exactly one**, invoked every 5 minutes:

```text
*/5 * * * *   php $HOME/app/bin/cron.php >> $HOME/var/log/cron.log 2>&1
```

`cron.php` is a dispatcher, not a job:

1. Take an exclusive `flock()` on `data/locks/cron.lock`; exit immediately if held.
   Overlapping runs are prevented by construction, not by hoping jobs finish in time.
2. Consult a job registry of `(name, schedule, last_run)` and select what is due.
3. Run each due job inside its own try/catch with a time budget. One failing job must
   not starve the rest.
4. Record start, end, outcome and error per job.

Jobs: drain the notification queue, expire stale sessions, prune old login attempts,
run daily backups, refresh booking reminders.

As of Package 7.1 the notification job exists and runs as its own entry point,
`php bin/run-notification-jobs.php --config=PATH`, which is already safe to overlap: it
takes no `flock()` because it does not need one — the durable lease in the queue is
what stops two ticks delivering the same job, and it does so across hosts rather than
across one filesystem. When the `cron.php` dispatcher above is built, this becomes one
of its jobs rather than a second cron entry.

Every job is **idempotent** and safe to run twice — the cron may fire late, twice, or
not at all, and correctness cannot depend on it.

If the plan cannot run CLI cron, the fallback is an HTTP-triggered endpoint protected
by a long shared token and rate-limited, called by an external scheduler. This is
strictly worse and is a fallback, not a plan.

### SMTP

- Transactional mail (booking confirmation, admin notification) via the mailbox
  provided with the hosting, over authenticated SMTP, TLS, credentials from `config/`.
- Mail is **queued to SQL and sent by the cron runner**, never sent inline during a web
  request. A slow or down mail server must not make a booking form hang or a booking be
  lost after it was accepted. Package 7.2 implements this with Symfony Mailer. Host,
  port, encryption (`none`, required STARTTLS or implicit TLS), optional authentication,
  sender identity and a 1–30 second socket timeout are deployment configuration; no
  Hetzner value is assumed. Provider messages and credentials never enter job errors or logs.
- Create, move and cancel enqueue their e-mail in the same transaction as booking and
  history. Confirmed bookings get a reminder due exactly 24 hours before their Paris
  appointment. A move terminally supersedes only the old pending reminder and creates a
  new occurrence-keyed reminder; cancellation retires pending reminders. Sent history is
  never rewritten, and an already-expired catch-up window is recorded as a terminal skip.
- A send failure retries with backoff and a bounded attempt count, then parks the row
  for operator attention rather than retrying forever. Implemented: five attempts,
  60/120/240/480-second backoff clamped at one hour, then terminal `failed`.
- SPF, DKIM and DMARC configured for the domain — otherwise confirmations land in spam,
  which for this project is indistinguishable from not sending them.

### SMS

- Outbound SMS through the **Hetzner SMS gateway**, used for operator alerts on new
  bookings.
- Same queue, same runner, same retry policy as mail: one notification pipeline with
  a channel discriminator, not two. Built that way in Package 7.1 — `channel` is a
  column, and the only thing an SMS provider adds is a transport implementation.
- Credentials from `config/`. The exact endpoint, authentication scheme and per-message
  cost must be confirmed against the Hetzner account before implementation — this
  document fixes the **integration boundary** (queue → cron → gateway adapter), not the
  wire protocol.
- SMS is best-effort and strictly secondary: a failed SMS must never fail or roll back
  the booking that triggered it.

---

## 12. Routing and deep links

> **Built (ESZ-022).** The rules are declared in
> `php/src/Deploy/DocumentRootRouting.php`, rendered into `php/public/.htaccess` by
> `php/bin/generate-htaccess.php`, and covered by `php:routing` — which also fails if
> the committed file drifts from the table. What is still unproven is Apache applying
> it; that is `smoke:http`.

`.htaccess` rules, in this order — the order is the specification, not an implementation
detail:

1. `/api/...` → `public_html/api/index.php`. **First**, so no later catch-all can
   swallow an API route and turn a JSON 404 into an HTML page.
2. Existing file or directory → served directly (assets, `media/`).
3. `/` and public deep links (`/#prestations`, …) → the PHP-injected public page (§5).
   Section anchors are client-side fragments and need no server rule; the fixed-navbar
   offset behaviour is already covered by the frontend suite.
4. `/admin/...` → `public_html/admin/index.html`, so a refresh on a deep admin link
   loads the shell instead of 404-ing.
5. Anything else → the static 404 page for document requests, and the **JSON error
   envelope** for anything under `/api`. A request to an unknown API path must never
   receive HTML: `docs/contract-freeze.md` freezes that 404 body.

`trailingSlash` behaviour must be fixed once, in `next.config.ts`, and matched by the
rewrite rules. Getting this wrong produces redirect loops that only appear in
production.

---

## 13. Build and deployment flow

```text
developer / CI (Node available)
  1. npm ci                       (contracts, front)
  2. contracts: generate + verify:generated   ← fails on artifact drift
  3. all Phase-0 gates             (docs/v1-quality-gates.md)
  4. front: next build → front/out/
  5. package: front/out/ + app/ + public_html/api/index.php + vendor/
       ↓ SFTP / rsync over SSH
Hetzner webhosting (no Node, ever)
  6. upload into a staging directory
  7. run pending SQL migrations
  8. swap staging → live
  9. smoke test: /api/health, /api/content, /, /admin
```

- Composer dependencies are installed **during the build**, not on the host. `vendor/`
  ships as part of the artifact.
- The swap should be a symlink flip if the plan permits symlinked document roots;
  otherwise `rsync --delete` into the live directory, accepting a short inconsistent
  window. **Which of the two applies must be confirmed on the account** — it changes
  the deployment script materially.
- `data/`, `config/` and `backups/` are **never** touched by a deploy. Only code and
  static assets are replaced.
- Migrations run **before** the swap and must be backward-compatible with the code
  still live at that moment.
- Rollback is redeploying the previous artifact. Since migrations are forward-only, any
  migration that cannot be rolled back by a subsequent forward migration must be
  flagged at review time.

### What this supersedes

`docs/backend-target-architecture.md` proposed deploying the Express API to a
container host with a persistent volume and the frontend to Vercel. That is **no longer
the production plan**, and as of ESZ-015 it is no longer a plan at all: the Express
service, its Dockerfile and its gates were deleted once PHP replayed the same
`http-contract.json` green. That document is retained as history and labelled as such.
`php/tests/Http/HttpContractConformanceTest.php` is now the executable proof of the
frozen contract.

---

## 14. Open items for Phase 1

Carried forward from `docs/runtime-inventory.md` §12, plus what this document adds:

1. **Confirm the hosting plan's actual capabilities** — document root path and whether
   it can be symlinked, PHP version, CLI cron availability and entry count, MySQL
   version, SSH access, disk quota. Several decisions above are conditional on these.
2. **Contract-first extension** — `/api/admin/*` must enter `contracts/http-contract.ts`
   **before** any PHP is written. `/api/auth/*` is **done (ESZ-025)**: the three routes,
   their statuses, the session-cookie attributes, the CSRF lifecycle, the login-failure
   outcome and the identity normalisation rules were all added to the contract and the
   artifacts regenerated before the endpoints existed, and PHP reads its security posture
   out of `http-contract.json` rather than restating it.
3. ~~**`uptimeSeconds` semantics**~~ — **closed (ESZ-013).** No value was invented; the
   field left the contract. See `docs/contract-freeze.md`, Part 4.
4. ~~**Fail-fast on broken storage**~~ — **closed (ESZ-013).** §9's "fail the request
   loudly" is what shipped: storage is not touched at boot, and an unreadable or
   invalid published document is a 500 `STORAGE_FAILURE` on `GET /api/content` only.
   `/api/health` reads nothing, which is now a contract invariant.
5. **Booking data retention** — required before the first real booking is stored.
6. ~~**Admin session storage**~~ — **closed (ESZ-025).** SQL-backed, as specified. PHP's
   own session extension was rejected for two reasons: it is global state
   (`$_SESSION`, direct header emission) in a layer deliberately built to have none —
   `Request` exists precisely so the HTTP layer is testable without a web server — and
   `session_start()`, `session_id()` and `session_regenerate_id()` all refuse once
   `headers_sent()` is true, which under the CLI SAPI is immediately, so rotation-on-login
   and logout invalidation would have been the two properties most worth proving and the
   two that could not be. What the extension would have provided — an opaque random id, a
   server-side record, refusal to adopt a client-chosen id, rotation on privilege change —
   is provided by `SessionManager` and `PdoSessionStore`, and all four are covered tests.
7. ~~**`/admin` is unprotected**~~ — **closed (ESZ-025/026).** The shell is still a
   static file reachable by anyone who knows the path, and always will be; what was
   actually at risk was the endpoints it would call, and those are now enforced by PHP
   per request. A session is an opaque id naming a server-side row, a disabled account is
   rejected on its *next request* rather than at its next login, and every
   state-changing call needs a per-session CSRF token in addition to `SameSite=Strict`.
   The commented-out Basic auth block in the generated `.htaccess` was the stopgap for
   this item and is no longer the thing standing between `/admin` and the internet.
8. **Apache has never executed the generated rules** — `php:routing` proves the table
   and that `.htaccess` matches it, using only directives legal in that context, but
   not that `mod_rewrite` is enabled, that `AllowOverride` permits them, or that
   `DirectoryIndex disabled` behaves as assumed on this plan. First deploy must run
   `smoke:http` before anything else is trusted.
9. **Login throttling** — opened by ESZ-025. §6 asks for rate-limited attempts keyed by
   account and by source address, with a counter in SQL. Not built, and deliberately not
   half-built: a counter that nothing enforces reads like a control while being none.
   The uniform failure response and the absence of user enumeration that §6 asks for in
   the same breath *are* built and covered.
10. **`/reservation` is a static export** — Package 5.1 resolves it explicitly to
   `reservation.html`. It discovers active services and availability through same-origin
   PHP APIs; no Node renderer or public-page content injection is required.
