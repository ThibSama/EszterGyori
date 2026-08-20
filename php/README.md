# `php/` — the PHP backend (ESZ-010 → ESZ-022)

The backend for Hetzner shared hosting, and since Package 1.2 the **only**
implementation of the frozen public surface. Package 1.1 built the foundation —
bootstrap, routing, contract-driven validation, atomic JSON storage. Package 1.2
added the two public routes, proved them against the full HTTP contract, and
retired the Express reference service that had co-implemented the surface since
ESZ-002.

Package 2.1 (ESZ-020/021/022) widened its job: with the Next server gone, PHP also
serves **`/`**, injecting the published content into the exported HTML, and owns
the document-root routing.

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
| `/api/admin/*`, `/api/auth/*` | Not started; frozen at 404 by the contract |
| Admin authentication and authorisation | **Package 2.2. `/admin` is currently unprotected** — see `docs/hetzner-target-architecture.md` §14, item 7 |
| SQL, sessions, CSRF, media, booking, notifications | Later packages |

Three routes are registered: `/api/health`, `/api/content` and `/`. Every other `/api/*` path
answers the frozen structured JSON 404 — the contract's specified behaviour for a
path that is not implemented yet, asserted against `http-contract.json` by
`tests/Http/HttpFoundationTest.php`. `/api/admin/*` and `/api/auth/*` stay
unregistered on purpose: routing one before it is contracted would be a silent
breaking change.

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
composer run test              # PHPUnit
composer run contracts:sync    # copy contracts/generated/ to php/contracts/
composer run contracts:check   # fail if that copy is stale

php bin/generate-htaccess.php  # re-render public/.htaccess from the routing table

cd ..
npm run validate               # every gate, in policy order
```

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
```

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
