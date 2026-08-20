# `php/` — the PHP backend (ESZ-010 → ESZ-027)

The backend for Hetzner shared hosting, and since Package 1.2 the **only**
implementation of the frozen public surface. Package 1.1 built the foundation —
bootstrap, routing, contract-driven validation, atomic JSON storage. Package 1.2
added the two public routes, proved them against the full HTTP contract, and
retired the Express reference service that had co-implemented the surface since
ESZ-002.

Package 2.1 (ESZ-020/021/022) widened its job: with the Next server gone, PHP also
serves **`/`**, injecting the published content into the exported HTML, and owns
the document-root routing.

Package 2.2 (ESZ-023/024/025/026/027) gave it the other thing the static host took
away: **authorisation**. A PDO layer with ordered, repeat-safe migrations; the
`admin_accounts` and `admin_sessions` schema; an operator-run provisioning CLI;
server-side sessions with per-session CSRF; and production configuration that
refuses to boot on an unsafe setting.

Companion documents: `docs/contract-freeze.md` (the frozen surface and the
contract artifacts), `docs/hetzner-target-architecture.md` (the target topology),
`docs/static-frontend-and-injection.md` (Package 2.1), `docs/v1-quality-gates.md`
(the validation policy).

---

## What runs today

| Concern | State |
| --- | --- |
| Front controller, routing, request ids, JSON error envelopes | ESZ-010, done |
| Configuration loading, fail-fast validation, structured logging | ESZ-010, done |
| Contract-driven validation (JSON Schema + semantic rules + parity replay) | ESZ-011, done |
| `draft.json` / `published.json` atomic storage, locking, seeding | ESZ-012, done |
| `GET /api/health` | ESZ-013, done |
| `GET /api/content` | ESZ-014, done |
| `GET \| HEAD /` — the public page, with published content injected | ESZ-021, done |
| Document-root routing, generated from a tested table | ESZ-022, done |
| Full `http-contract.json` replay against the real kernel | ESZ-021, done — **every case, no exemptions** |
| PDO layer, ordered repeat-safe migrations, `schema_migrations` | ESZ-023, done |
| `admin_accounts` schema, hashing, operator provisioning CLI | ESZ-024, done |
| `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout` | ESZ-025, done |
| Server-side sessions: opaque id, MySQL record, rotation on login, two deadlines | ESZ-025, done |
| Per-session CSRF token on every state-changing request | ESZ-026, done |
| Production config boundaries and secret hygiene | ESZ-027, done |
| `GET`/`PUT /api/admin/content/draft`, `POST …/publish`, `POST …/reset` | Package 3.1 (ESZ-030/031/032/033), done |
| `GET \| POST \| DELETE /api/admin/media` | Package 3.3 (ESZ-036/037), done |
| Login throttling | **Not built.** `docs/hetzner-target-architecture.md` §6 asks for it; ESZ-025 did not deliver it |
| The `/admin` login form in the browser | Package 3.2 (ESZ-034), done — reads the anonymous session for CSRF, posts credentials to PHP, then enters `/admin` |
| Booking, notifications | Later packages |

Ten routes are registered: `/api/health`, `/api/content`, `/`, the three
`/api/auth/*`, the three admin content paths (`/api/admin/content/draft` under both
`GET` and `PUT`, plus `…/publish` and `…/reset`), and `/api/admin/media` under `GET`,
`POST` and `DELETE`. No `/api` path is frozen at 404 any more; an unknown one still
answers the frozen structured JSON 404, asserted against `http-contract.json` by
`tests/Http/HttpFoundationTest.php`.

An unimplemented route stays unregistered on purpose: routing one before it is
contracted would be a silent breaking change. That ordering has now been followed
three times — the auth routes in Package 2.2, the admin content routes in Package 3.1
and the media routes in Package 3.3 were all added to `contracts/http-contract.ts`
*first*, with the artifacts regenerated and the drift gate green, before a line of PHP
was written for them.

The media surface has no `{id}` route. `Router` is exact-path by construction, and the
delete carries its id in a schema-validated body — the reasoning is in the contract
under `mediaDeleteRequestSchema`, and the practical consequence is that an id which
could express a path fragment is refused by the schema rather than by a sanitiser
somewhere downstream.

The auth, admin content and media routes are registered only when a database is configured,
because both need somewhere to keep a session. Production cannot
reach the state where they are missing — `Configuration` refuses to boot in production
without a `database` block — and outside production a deployment that only serves the
public read-only surface needs no SQL at all and opens no connection.

**`/admin` enforces nothing.** It is a static file: anyone may fetch it, read it and
call whatever it calls. Every guarantee about who may do what is made here, per
request, and none of it is delegated to the shell.

**No Node at runtime.** The backend reads the committed
`contracts/generated/*.json` artifacts as data. Node is a build-time toolchain for
regenerating them and nothing else.

---

## Layout

```text
php/
├── composer.json / composer.lock
├── phpunit.xml.dist  phpstan.neon.dist  phpstan.tests.neon.dist  phpcs.xml.dist
├── bin/
│   ├── lint.php              php -l over every source file
│   ├── static-analysis.php   PHPStan (two pins) + PSR-12
│   └── sync-contracts.php    copy + verify contracts/generated/ for deployment
├── config/config.example.php
├── public/api/index.php      the ONLY web-reachable PHP file
├── src/
│   ├── Kernel.php            boot, handle, send
│   ├── Config/               file-based configuration, fail-fast
│   ├── Contract/             artifacts, structural + semantic validation, parity
│   ├── Http/                 request, response, router, request ids, error catalog
│   │   └── Endpoint/         GET /api/health, GET /api/content
│   ├── Storage/              atomic JSON files, flock, content storage
│   └── Support/              clock, canonical timestamps, JSON-lines logger
└── tests/
```

The repository layout and the Hetzner layout differ only in where the app root
sits; `public/api/index.php` detects both, so deploying is a copy rather than a
rewrite.

| | Repository | Hetzner |
| --- | --- | --- |
| Front controller | `php/public/api/index.php` | `public_html/api/index.php` |
| App root | `php/` | `$HOME/app/` |
| Config | `php/config/config.php` | `$HOME/config/config.php` |
| Contract artifacts | `contracts/generated/` | `$HOME/app/contracts/` |

---

## ESZ-011 — how validation stays honest

The risk this design exists to remove is two hand-maintained schemas drifting
apart. So **PHP re-derives nothing**. It consumes the artifacts:

1. **Structure** — `StructuralValidator` runs the committed
   `*.schema.json` documents through `opis/json-schema` (2020-12). No schema is
   written in PHP.
2. **Semantics** — `SemanticRuleValidator` implements, one method per rule id,
   everything `semantic-rules.json` declares as unrepresentable in JSON Schema:
   WCAG contrast floors, positional id ordering, fixed technical ids, ISO-8601
   round-trip exactness, `mailto:` and Instagram-host restrictions, media source
   protocols, hex normalisation and `appearance` defaulting.
3. **Proof** — `tests/Contract/ParityCorpusTest.php` replays all 39 cases of
   `parity-corpus.json`, comparing accept/reject **and** issue paths against the
   values the reference implementation produced.

Three additional guards, all failing tests rather than review conventions:

- every artifact is verified against its `manifest.json` SHA-256 digest on load,
  so a truncated deploy fails instead of validating loosely;
- `assertCoversDeclaredRules()` runs at bootstrap: a rule added upstream and not
  ported here aborts the boot;
- `SemanticRuleCoverageTest` asserts the two rule sets are equal in both
  directions, and that the media-path regex matches the generated schema's.

### `format` is not asserted

`allowFormats` is switched off in the structural validator. The reference emits
`format` as an annotation only, and the real restrictions behind those
annotations are declared semantic rules. Asserting `format` structurally *as well*
would put one constraint in two places with two different definitions.

### Composition: structure, then normalise, then semantics

A structural failure short-circuits. Upstream, a `.superRefine` never runs over an
object that failed to parse, so reporting semantic issues on a structurally broken
document would invent paths the reference never emits. Normalisation sits in the
middle because two declared rules *are* normalisations, and the contrast rules
must see the injected `appearance` defaults.

### The gap found in the contract artifacts is closed

`galleryContentSchema.instagramCta.superRefine` pins that link id to
`instagram-more`, exactly as `contact.fixedLinkIds` pins its two — but
`semantic-rules.json` emitted **no rule entry for it**. Package 1.1 enforced it
here anyway (not enforcing it would let PHP accept a document the reference
rejects) and listed it in `SemanticRuleValidator::UNDECLARED_RULES`.

Package 1.2 fixed it upstream instead: `gallery.instagramCtaFixedId` is now a
declared rule with a rejecting parity case, the artifacts were regenerated, and
both the local workaround and `UNDECLARED_RULES` are gone. That is why the corpus
is 39 cases and not 38.

### Known deliberate divergences

| Case | Reference | Here | Why |
| --- | --- | --- | --- |
| Expanded-year timestamps (`+275760-09-13T…`) | accepted | rejected | Rejecting is the safe direction, and no such value can arise from this application's own writes. |
| E-mail address grammar | Zod's `z.email` regex | `FILTER_VALIDATE_EMAIL` | Both accept ordinary addresses; exotic edge cases may differ. No corpus case distinguishes them. |
| Structural issue paths | Zod issue paths | JSON Schema paths | Only reachable for documents the corpus never produces; the corpus itself matches exactly. |

---

## ESZ-012 — storage

`data/content/draft.json` and `data/content/published.json`, with the envelope and
revision semantics unchanged: `revision` is a non-negative integer and the **only**
input to the `"published-<revision>"` ETag.

- **Atomic writes** — temp file in `var/tmp/` → `fflush` → `fsync` → `chmod 0640`
  → `rename()`. Skipping the fsync makes the rename durable while the bytes are
  not; a power loss then leaves an empty file where content was.
- **Same filesystem** — `rename()` is only atomic within one filesystem, so
  bootstrap `stat`s both directories and refuses to start if they differ.
- **Locking** — advisory `flock()` on `data/locks/content.lock`. Reads take
  `LOCK_SH`; the exclusive lock is held for a whole read-modify-write and for
  seeding, which re-checks under it. Shared-hosting-safe: no daemon, no SysV IPC,
  no `pcntl`. It does not work over NFS, so `data/` must be local storage.
- **Size cap** — 1 MB, checked *before* reading, so an oversized file is never
  pulled into memory.
- **Seeding** — idempotent. A missing file is seeded from the canonical defaults;
  an existing file is validated and **never** overwritten.

### Strict fail-fast, and where it now lands

A required file that is malformed, oversized, schema-incompatible or semantically
invalid **is never repaired, replaced or bypassed**. Package 1.1 enforced that by
aborting the boot. Package 1.2 kept the guarantee and moved where it surfaces:
storage is no longer touched at boot, so an unreadable or invalid published
document is a 500 `STORAGE_FAILURE` on `GET /api/content` — the status the
contract already freezes for it — rather than a failure on every path including
health. Nothing is weakened; the failure simply lands on the request that asked
for it.

Boot itself is still fail-fast for what it does load: unusable configuration or
corrupt contract artifacts abort with the frozen 500 envelope on any path
(`bootstrapFailure` in the contract, exercised by `KernelBootTest`).

PHP has no startup, so "bootstrap" is per request. The retired reference service
paid this once at `listen()`; here it is paid every time. The canonical document is
~8 kB, so this is affordable, and it is the only way to keep the guarantee on a
model with no long-lived process.

`writeDraft()` and `writePublished()` exist and are tested, but **no HTTP route
reaches them**. Draft writes and publication are later packages, and per the
contract they must be added to `contracts/http-contract.ts` before they are routed.

---

## ESZ-013 / ESZ-014 — the public routes, and the decisions they settled

Package 1.1 handed four open decisions forward. All four are settled, and each one
is now contract or code rather than a note.

1. **`uptimeSeconds` left `/api/health`.** Shared-hosting PHP has no meaningful
   process uptime, and a field that cannot be true is worse than an absent one. The
   field and the `health.uptimeMonotonic` invariant were removed from
   `contracts/http-contract.ts`, the artifacts were regenerated, and the field went
   out of the Express handler with the service itself. The frozen 200 body is
   `status`, `service`, `contentSchemaVersion`, `timestamp`.

2. **Health does not boot storage.** `Kernel::boot()` no longer initialises content
   storage; only the route that needs it touches it. Two consequences that Package
   1.1 flagged are gone with it: an editor's bad publish no longer reads as an
   outage, and a 500 is no longer reachable on a path frozen at 200/400/405. The
   property is an invariant in the contract now —
   `health.doesNotDependOnContentStorage` — not a convention.

3. **A body over the 64 kB cap is 400 `INVALID_JSON`,** frozen as
   `overLimitBodyOutcome`. Express had drifted to a 500 `INTERNAL_ERROR`; PHP's
   answer was the one adopted, because it reuses the existing error model instead of
   widening it and 400 is the honest class. Enforced before routing and regardless
   of `Content-Type`, so an oversized body is a 400 even on a path that would
   otherwise 404 or 405.

4. **Bootstrap no longer serialises requests.** Reads take the shared lock; the
   exclusive lock is reserved for seeding and writing, and seeding re-checks under
   it. The throughput ceiling Package 1.1 described is removed.

### `GET /api/content`

Reads the published envelope, **revalidates it on the way out**, and answers with
`ETag: "published-<revision>"` and the contract's `Cache-Control` — on 200 and on
304 alike. A 304 carries no body at all: not an empty object, not a `Content-Type`.

Revalidating a document the reader already validated is deliberate. The frontend
falls back to default content when a response fails its own schema check, so a
drifted response would not raise anywhere — the site would just quietly show
defaults. Re-validating turns that into a 500 someone can find. A storage failure
and a failed revalidation collapse to the *same* opaque 500 `STORAGE_FAILURE`; the
distinction is kept in the log, where it is useful, and out of a body an anonymous
caller can do nothing with.

### Conformance

`tests/Http/HttpContractConformanceTest.php` replays all 26 cases of
`contracts/generated/http-contract.json` against the real `Kernel` (gate
`php:http-contract`). The storage-failure cases are driven through an injected
`PublishedContentReader` rather than a deliberately corrupted file, so each case
raises exactly the failure it names.

One case is exempt for PHP — `unknown.get.rootNotFound` — because the front
controller is mounted at `/api` and owns nothing else; on the target host `/` is
the static site, so a 404 there would be a bug. The exemption is declared in the
artifact and the suite asserts there is exactly one, so a migration difference can
never look like a skipped test.

---

## Commands

```bash
cd php
composer install
composer run lint              # php -l over every source file
composer run stan              # PHPStan (max on src+bin, 6 on tests) + PSR-12
composer run test              # PHPUnit — the `eszter` suite, no database needed
composer run contracts:sync    # copy contracts/generated/ to php/contracts/
composer run contracts:check   # fail if that copy is stale

php bin/generate-htaccess.php  # re-render public/.htaccess from the routing table

# Operator commands (ESZ-023 / ESZ-024). Both are safe to run twice.
php bin/migrate.php --config=config/config.php --status
php bin/migrate.php --config=config/config.php
php bin/provision-admin.php --config=config/config.php --list
php bin/provision-admin.php --config=config/config.php --email=her@example.com
php bin/provision-admin.php --config=config/config.php --email=… --set-password
php bin/provision-admin.php --config=config/config.php --email=… --disable

cd ..
npm run validate               # every gate, in policy order
```

### The SQL gates need a database, and say so when they lack one

```bash
export ESZTER_TEST_DB_DSN='mysql:host=127.0.0.1;port=3306;dbname=eszter_test;charset=utf8mb4'
export ESZTER_TEST_DB_USERNAME=eszter
export ESZTER_TEST_DB_PASSWORD=…

vendor/bin/phpunit --testsuite sql-migrations
vendor/bin/phpunit --testsuite sql-integration
```

Without those variables both gates report NOT RUN naming the missing prerequisite,
which per `docs/v1-quality-gates.md` is never a pass. The suites refuse any database
whose name does not end in `_test` — they drop and truncate tables, and a naming rule
is a cheap way to make pointing them at something real impossible rather than merely
discouraged. MySQL specifically, not SQLite: the implicit commit around DDL is the
property the whole migrator is designed around, and an engine with transactional DDL
would make that design look unnecessary while going green.

### Provisioning an admin

No account is ever created implicitly — not by a migration, not at boot, not on a
first request. A default account would be identical on every deployment of this
application and would be found by the first scanner that looked. The password is read
from the terminal with echo off, or from stdin when piped; `--password=…` is refused,
because process arguments are visible to every user on the host through `ps` and are
written to the operator's shell history.

`public/.htaccess` and `public/media/.htaccess` are **generated**, not hand-written.
Edit `src/Deploy/DocumentRootRouting.php` (the rules) or `src/Deploy/HtaccessRenderer.php`
(the rendering), then re-run the generator; `php:routing` fails if the committed files
have drifted.

## Deployment sketch (not yet automated)

```bash
php bin/sync-contracts.php --target=/path/to/app/contracts
composer install --no-dev --optimize-autoloader
npm --prefix ../front run build          # produces front/out/

# copy php/src, php/vendor, php/bin, php/contracts  → $HOME/app/
# copy front/out/*                                  → public_html/
# copy php/public/api/*                             → public_html/api/
# copy php/public/.htaccess                         → public_html/.htaccess
# copy php/public/media/.htaccess                   → public_html/media/.htaccess
# copy php/config/config.example.php → $HOME/config/config.php, chmod 0600, edit

php bin/migrate.php --config=$HOME/config/config.php    # before the swap, on the host
```

`chmod 0600` is not advice. In production the loader reads the file's mode and refuses
to boot if it is readable by group or others, because on shared hosting that means
readable by the other tenants and the file holds the database password.

### PHP settings the upload route needs

`POST /api/admin/media` accepts an 8 MiB image, and PHP has to be configured to let one
through. These are hosting settings; the front controller cannot raise them from inside
a request.

| Setting | Minimum | Why it matters |
| --- | --- | --- |
| `file_uploads` | `On` | Off means `$_FILES` is always empty and every upload looks like a missing file. |
| `upload_max_filesize` | `8M` | The frozen per-file limit. Below it PHP refuses the file itself and the route answers 413. |
| `post_max_size` | `10M` | Must exceed `upload_max_filesize` plus the multipart framing. **Below the body size PHP discards the body silently** — empty `$_POST`, empty `$_FILES`, no error code — which is indistinguishable from "no file attached" without the `Content-Length` check `AdminMediaUploadEndpoint` performs. That check turns it into an honest 413; the setting is the actual fix. |
| `memory_limit` | `256M` | Bounded by the 40-megapixel cap rather than by the byte limit: the decoded pixels alone can occupy about 160 MB, before GD and PHP overhead. |
| `max_execution_time` | `30` | Decode plus re-encode of a 24 MP JPEG. |
| `extension=gd` | required, **with JPEG, PNG and WebP** | A `gd` built without WebP loads fine and silently cannot verify a third of the allowlist, so the route checks `gd_info()` per format rather than trusting `extension_loaded('gd')`. |
| `extension=fileinfo` | required | Typing an upload from its bytes. |

A host missing `gd`, `fileinfo`, or one of the allowlisted GD codecs answers **500
`INVALID_CONFIGURATION`** on upload and stores nothing, rather than degrading to a
weaker check. The PHP size and execution settings are deployment prerequisites: an
undersized request limit is surfaced as 413 where PHP leaves enough evidence, while a
memory or execution limit can terminate PHP before the application can form an envelope.
`imagick` is not required and is not used. Verify with:

```bash
php -r 'var_dump(ini_get("upload_max_filesize"), ini_get("post_max_size"), extension_loaded("gd"), extension_loaded("fileinfo"), gd_info()["WebP Support"]);'
```

`config.php` gains `paths.mediaOriginals`, a sibling of the document root that holds the
verified originals and the `.intake/` staging directory. It must never be web-reachable.
Intake is a subdirectory of it precisely so finalising the original cannot cross a
filesystem boundary; derivative staging separately lives inside `public/media/` for the
same reason.

`config.php` must set `paths.public` to the document root: `/` is served by reading
`index.html` out of it and injecting the published content, so a deployment that ships
the backend without the export answers 500 on the home page. That is deliberate — there
is no page to degrade *to* — and it is the one public-page failure that is not
survivable, which makes it worth checking first after a deploy.

The Apache rules have never been executed by a real Apache. `php:routing` proves the
table and that the committed files match it, using only directives legal in `.htaccess`,
but not that `mod_rewrite` is enabled or that `AllowOverride` permits them. Run
`smoke:http` before trusting the first deploy.

`config/config.php` is never committed. `.gitignore` excludes it, along with
`php/vendor/`, `php/contracts/`, `php/data/` and `php/var/`.
