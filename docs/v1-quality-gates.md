# ESZ-005 — V1 quality gates

One validation policy for the whole project: what is checked, in what order, what each
outcome means, and what may block a release.

Executable entry point: **`npm run validate`** (`scripts/validate.mjs`).

Companion documents:

- `docs/contract-freeze.md` — ESZ-002/ESZ-003, what the contract gates enforce.
- `docs/runtime-inventory.md` — ESZ-001, the responsibility inventory.
- `docs/hetzner-target-architecture.md` — ESZ-004, the architecture these gates validate.

---

## 1. Principles

1. **One entry point.** `npm run validate` is the whole policy. If a check is not
   reachable from it, it is not a gate — it is a habit.
2. **Deterministic.** Same commit, same inputs, same verdict. No network in the
   currently executable gates, no wall-clock dependence, no ordering luck. Gates run
   sequentially with `TZ=UTC`, `CI=1`, `NO_COLOR=1`.
3. **NOT RUN is not PASS.** A gate that cannot execute is printed, counted separately,
   and excluded from any success claim. It is never silently skipped, and never
   reported green.
4. **Ordered by cost and by dependency.** Cheap, foundational checks first, so the
   first failure is the most informative one available.
5. **Contract before implementation.** No implementation gate can pass a behaviour the
   contract does not describe. New endpoints enter `contracts/http-contract.ts` and the
   parity corpus *before* they are built.
6. **Gates fail loudly or not at all.** A check that cannot distinguish broken from
   working is removed rather than kept as reassurance.

---

## 2. Outcome semantics

| Outcome | Meaning | Counts as success? | Exit code impact |
| --- | --- | --- | --- |
| **PASS** | The gate executed and its assertions held. | Yes | none |
| **FAIL** | The gate executed and its assertions did not hold, or its tooling errored. | No | exit 1 |
| **NOT RUN** | The gate is declared but a prerequisite component does not exist (no PHP, no database, no deployed origin, no browser runner). | **No** | none |

Three rules govern NOT RUN, and they are what keep the policy honest:

- A NOT RUN gate must carry a **declared reason** naming the missing prerequisite.
- **Missing tooling that should be present is a FAIL, not a NOT RUN.** If PHP exists in
  the repository and `php` is absent from the environment, that is a broken
  environment, not an unavailable gate.
- A gate may only be NOT RUN while its subject genuinely does not exist. It **must**
  flip to executing on the commit that introduces its subject. Adding PHP without
  activating the PHP gates is itself a review failure.

The runner's exit code is 0 when nothing failed, 1 when any gate failed, 2 on a runner
error. **Exit 0 with NOT RUN gates present does not mean "V1 is validated"** — it means
"everything currently checkable is green". The runner prints exactly that.

---

## 3. Gate order

The order is the specification. Each stage assumes the previous one held.

| Stage | Gates | State |
| --- | --- | --- |
| **1. Static integrity** | lockfile sync (contracts, front), typecheck (contracts, contracts tools), frontend lint | Executable |
| **2. Contract artifacts** | `contracts:verify:generated` | Executable |
| **3. Contract semantics** | `contracts:test` — parity corpus, rule coverage, refinement census | Executable |
| **4. Frontend behaviour** | `front:test` | Executable |
| **5. Build** | contracts `dist/`, frontend production build | Executable |
| **6. PHP validation** | composer validate, lint, static analysis, unit tests, parity-corpus replay, full `http-contract.json` replay | Executable |
| **7. SQL** | migration tests, integration tests | Executable **when `ESZTER_TEST_DB_DSN` names a disposable MySQL database**; NOT RUN otherwise |
| **8. HTTP smoke** | live origin checks | **Not run** |
| **9. Browser scenarios** | public, admin, booking | **Not run** |
| **10. Security and configuration** | exposure, headers, permissions, advisories | **Not run** |

> **Renumbered in Package 1.2 (ESZ-015).** The policy used to carry a stage 4,
> *Implementation conformance*, whose only gate was `api:test` — the HTTP contract
> suite against the running Express service. Express is retired and that gate is
> gone; the conformance obligation did not disappear with it, it moved to
> `php:http-contract` in stage 6, against the only implementation that remains.
> `api:lockfile` and `api:typecheck` left stage 1 for the same reason.

Why this order:

- **Lockfiles first.** A drifted lockfile makes every later result describe a tree that
  no clean install will reproduce. This is not hypothetical — a drifted
  `front/package-lock.json` is exactly what Package 0.2 had to repair.
- **Artifact drift before semantics.** If `contracts/generated/` is stale, the parity
  corpus is validating yesterday's contract, and a green result is misleading.
- **Contract before conformance.** `php:http-contract` asserts the implementation
  matches the artifacts stage 2 proved current, so it cannot run first.
- **Builds before PHP.** They are slow and undiagnostic, but they are also what
  produces `contracts/dist/` for the frontend; a type error should still surface in
  stage 1, not as a build failure.
- **PHP and SQL after all contract stages.** The PHP implementation is validated
  *against* the contract, so the contract must be proven current first.

---

## 4. Currently executable gates

### Stage 1 — Static integrity

| Gate | Command | Proves |
| --- | --- | --- |
| `contracts:lockfile` `front:lockfile` | `npm ci --dry-run --offline` | `package.json` and `package-lock.json` are in sync and a clean install is reproducible. Offline, so the gate stays deterministic and network-free. |
| `contracts:typecheck` | `npm run typecheck` | Contract sources type-check. |
| `contracts:typecheck:tools` | `npm run typecheck:tools` | Generator scripts and contract tests type-check. |
| `front:lint` | `npm run lint` | ESLint, including the Next.js rule set. |

> **Note.** With `install-links=true` (see `front/.npmrc`), `npm ci --dry-run` also
> re-materialises `file:` dependencies such as `@eszter/contracts` into `node_modules`.
> The gate is therefore not purely read-only: it refreshes the linked package from
> `contracts/dist/`. That is harmless — it restores the true state — but it means the
> gate cannot be used to observe a locally hand-edited copy of a linked package.

### Stage 2 — Contract artifacts

`contracts:verify:generated` re-derives every artifact under `contracts/generated/` and
byte-compares it with what is committed, then checks the `manifest.json` SHA-256
digests. Editing a Zod schema without running `npm run generate` fails here. This is the
gate that makes "the committed contract is the real contract" a checked fact.

### Stage 3 — Contract semantics

`contracts:test` runs the parity corpus, the rule-coverage check (every declared
semantic rule has at least one case, and — outside the two normalisation rules — at
least one *rejecting* case) and the refinement census (a frozen count of `.refine`,
`.superRefine` and `.transform` occurrences; adding one without declaring its semantics
fails).

This is the suite a PHP implementation must replay unchanged. It is the single most
important gate in the policy, because JSON Schema alone cannot express these rules.

### Stage 4 — Frontend behaviour

`front:test` covers content encoding integrity (no mojibake, well-formed NFC UTF-8,
diacritics preserved — asserted structurally rather than against editorial sentences),
appearance and contrast rules, public/admin module isolation, local-backup semantics,
and responsive behaviour.

Since Package 3.2 it also covers the admin client against a stub `fetch`: what the API
client sends (the frozen paths, the CSRF header, `expectedRevision` on every write, and
`source: "published"` on a reset), how it classifies what comes back (401 expiry, 403
stale token, 409 with and without a revision header, 400 validation, a malformed 200,
a transport failure), the draft state machine's refusal to advance a revision on a
failed write, the sanitisation of `?next`, and the demotion of `localStorage` to an
explicit backup that is never read on load and never holds a session or CSRF secret.

Conflict recovery gets its own two suites, because it is the part with a defect worth
naming. `site-content-merge` proves the three-way reconciliation itself: two tabs editing
different sections both keep their work, the same field changed on both sides is refused
rather than picked, a reordered or resized list is refused as structural rather than
merged element-by-element, and the merged document is validated against `SiteContent`
before it is ever offered for a save. `admin-draft-reconciliation` proves what the editor
does with it, asserting on the *calls* and not only on the result: the local draft is
backed up before the first network call, a conflict writes nothing at all, a clean merge
is saved exactly once against the revision that arrived with the content it was merged
against, losing the second race fails without a retry, and publish/reset answer a 409 by
re-reading state and stopping. Alongside them the state machine asserts that no action
carrying no server envelope can move `revision` — the regression test for the removed
blind rebase, which used to adopt the head named in a 409 header and write over content
it had never read.

### Stage 5 — Build

`contracts:build` emits `dist/` for consumers.

`front:build` runs under `output: "export"` since ESZ-020, which makes this gate do
more than compile. The flag turns middleware, route handlers, `revalidate` and dynamic
rendering into **build errors**, so a change that would need a Node process in
production stops here rather than on a host that has none.

`front:export` then checks the artifact itself, because the flag can be removed in one
line and the resulting failure is not a build error — it is a deploy that looks fine
locally. It asserts that the build declared itself an export with no middleware,
rewrite or dynamic route; that every route reached `out/` as a file; that no route
handler, middleware entry point or server-only dependency survives in the tree; and
that `out/index.html` carries a parseable bootstrap payload and a colours-only
appearance block for ESZ-021's injection to rewrite.

It also asserts the exported HTML already contains the copy. A blank shell filled in by
JavaScript was the rejected design (`docs/hetzner-target-architecture.md` §5), and this
is what stops it being reintroduced by accident.

### Stage 6 — PHP validation

| Gate | Command | Proves |
| --- | --- | --- |
| `php:dependencies` | existence check on `php/vendor/autoload.php` | The PHP dependencies are installed. `php/vendor/` is not committed, so a fresh clone fails here with the command to run rather than four gates later on a missing binary. Per §2 this is a FAIL, not a NOT RUN: the subject exists and the tooling is merely absent. |
| `php:composer-validate` | `composer validate --strict` | `composer.json` is valid and in sync with `composer.lock`. |
| `php:lint` | `php bin/lint.php` | `php -l` over **every** PHP source file, including files no test happens to autoload — a parse error there is invisible to PHPUnit and fatal in production. |
| `php:static-analysis` | `php bin/static-analysis.php` | PHPStan at **level max** over `src/` and `bin/`, **level 6** over `tests/`, plus PSR-12. Both levels are pinned in committed configs, so the gate cannot drift by dependency upgrade. |
| `php:unit` | `vendor/bin/phpunit --testsuite eszter` | Configuration fail-fast — including ESZ-027's production refusals: a missing `database` block, a placeholder or empty DB password, a non-MySQL DSN, `session.cookieSecure: false`, and a config file readable by group or others. Plus contract-artifact digest verification, atomic JSON storage (temp-write, fsync, rename, size cap, locking, idempotent seeding, no silent replacement of an invalid file), the HTTP layer against `http-contract.json`, ESZ-025/026's auth invariants, and Package 3.1's admin content invariants — the shared revision sequence, publish atomicity and idempotence, ETag invalidation across `/` and `/api/content`, draft/published isolation, conflict-leaves-storage-untouched, and real two-process concurrency against one content directory. The suite is named explicitly rather than left to the default, so this gate cannot start depending on a database server. |
| `php:parity-corpus` | PHPUnit, contract suites | The PHP validator replays `contracts/generated/parity-corpus.json` with **identical** accept/reject outcomes and **identical** issue paths, every rule declared in `semantic-rules.json` is implemented, and structural validation is driven by the generated JSON Schema rather than a second hand-written schema. |
| `php:http-contract` | PHPUnit, HTTP suites | The full `http-contract.json` case list against the PHP HTTP layer: statuses and `Allow` headers, the closed error envelope, request-id generation and echo, `ETag` / `If-None-Match` / 304, cache headers, opaque storage failures, the over-limit body outcome and the bootstrap-failure envelope. Since ESZ-021 this includes `/`; since Package 3.1 it includes the three `/api/admin/content/*` paths, their `409 REVISION_CONFLICT` outcomes, the `x-content-revision` header and the per-case assertion that storage is byte-identical after every rejected write. The artifact's exemption set is asserted to be **empty**. |
| `php:public-page` | PHPUnit, `PublicPageBootstrapTest` | The injector rewrites only the two bootstrap elements and leaves the rest of the export byte-identical; it locates them by `id` rather than by a remembered opening tag; a missing element raises instead of producing a half-injected page; the payload stays valid JSON that no editorial string can break out of; and the appearance block emits exactly the custom properties the contract declares, dropping any value that is not a validated hex colour. |
| `php:routing` | PHPUnit, `DocumentRootRoutingTest` | `/api` resolves before anything can shadow it; static assets are served directly; `/admin` deep links survive a refresh; `/reservation` is reserved and ships no booking UI; `/` is never resolved as a static file; every declared rule is reachable; and the committed `.htaccess` is byte-identical to what the routing table renders, using only directives that are legal in that context. |

`php:parity-corpus` is the gate that made the migration safe, and it is green:
39/39 corpus cases, with the issue paths compared exactly rather than the outcomes
alone.

`php:http-contract` became executable in Package 1.2. It replays the generated JSON,
deliberately, not the TypeScript module, and it drives the real `Kernel` rather than a
stub. Two details are worth stating because they are what keep it honest:

- **Storage failures are injected, not staged.** `storage: failure` and
  `storage: malformed` are replayed through a `PublishedContentReader` that raises
  exactly the failure the case names. Writing a corrupt file and trusting it to
  produce that failure would test the corruption, not the contract.
- **Exemptions are data, not skips.** The one exemption that ever existed said `/` was
  not this service's to answer: the front controller was mounted at `/api`, and on the
  target host `/` was the static site. ESZ-021 made `/` a PHP endpoint, so the exemption
  stopped being true rather than being waived, and the set has been empty since. The
  suite asserts it is empty, so a skipped test can never be mistaken for a migration
  difference.
- **Admin content cases run against real storage, and that is also the point.** The
  opposite decision from the storage-failure cases above, for the opposite reason.
  `/api/content` is a read, so a raising fixture is the honest way to stage a failure.
  The admin routes *write*, and atomic replacement, locking and the revision sequence
  are precisely what a fixture would fake away — so those cases run against a real
  temp directory, real `draft.json` and `published.json` and the real `flock()`, and
  each one snapshots both files before the request and compares the bytes afterwards.
  Only the account directory and the session store stay doubles, so the gate still
  needs no MySQL.
- **Auth cases run against in-memory doubles, and that is the point.** The ESZ-025/026
  cases replay through `AccountDirectory` and `SessionStore` fixtures, so this gate
  proves the frozen surface anywhere, with no database. The SQL implementations of both
  interfaces are proved separately by `sql:integration` against a real MySQL server, and
  its last three tests drive the same front controller against it — so neither half
  rests on the other.

What stage 6 does **not** yet prove, and says so rather than being silently absent:

| Not covered | Why |
| --- | --- |
| Media, notification queue, booking | `php:unit` covers what exists. Those subjects do not exist yet; the gate widens as they arrive. |
| The browser editor writing to the server draft, end to end | Package 3.1 covered the `/api/admin/content/*` server surface; Package 3.2 connected the editor to it and covered the client side against a stub `fetch` (`front:test`). What neither half proves is the two running together against one origin: that is `browser:admin` in stage 9, and it needs a deployment. |
| Login throttling | `docs/hetzner-target-architecture.md` §6 asks for rate-limited, throttled login attempts keyed by account and by source address. ESZ-025 did not build it, so there is nothing to gate. Everything else §6 asks of authentication is built and covered. |
| A real browser exercising `/admin` | Package 3.2 built the client flow — sign-in, draft load, save, conflict, publish, reset — and `front:test` drives every branch of it as units. The gap that remains is a real browser against a real origin: cookie attributes the `__Host-` prefix only enforces in one, and the redirect after sign-in. `browser:admin` in stage 9 stays NOT RUN. |

---

### Stage 7 — SQL

Executable since ESZ-023, **conditionally**. The schema, the migrator and both suites
exist; what they need is somewhere to run. Both gates read `ESZTER_TEST_DB_DSN` (with
`ESZTER_TEST_DB_USERNAME` and `ESZTER_TEST_DB_PASSWORD`) and, when it is absent, report
NOT RUN naming *that* as the missing prerequisite — which is a materially smaller gap
than the one recorded here before, where the subject itself did not exist.

| Gate | Command | Proves |
| --- | --- | --- |
| `sql:migrations` | `vendor/bin/phpunit --testsuite sql-migrations` | Every migration applies to an empty database in version order; a second run applies nothing; a half-applied migration completes on the next run; editing an already-applied migration is refused on its checksum; a database recording a migration this checkout does not contain is refused; a misnamed file is refused rather than skipped; concurrent runs serialise on an advisory lock; and `schema_migrations` ends consistent. It also asserts the shape the code relies on: `utf8mb4`, InnoDB, the byte-exact `email` collation, and the session→account foreign key cascading. |
| `sql:integration` | `vendor/bin/phpunit --testsuite sql-integration` | The admin account and session repositories against a real MySQL instance seeded by the **real** migrations, each test isolated in a rolled-back transaction: repeat-safe provisioning, identity normalisation and the case/accent behaviour of the unique index, password hashing, both session deadlines with the absolute one un-extendable, targeted invalidation, garbage collection, and the whole login/CSRF/logout flow driven through the front controller against MySQL. |

Isolation is the requirement, not a preference:

- Tests run against a **disposable** database. `TestDatabase` refuses any database whose
  name does not end in `_test`, because these suites drop and truncate tables and a
  naming rule is a cheap way to make pointing them at something real impossible rather
  than merely discouraged.
- Each `sql:integration` test runs inside a transaction that is rolled back afterwards.
  `TRUNCATE` is deliberately not used per test: on MySQL it commits implicitly and would
  defeat the rollback it was meant to help.
- Fixtures are explicit. No test depends on rows another test created.

**MySQL, not SQLite.** The engine is what is under test: `utf8mb4` collation semantics,
`ON DUPLICATE KEY UPDATE`, `GET_LOCK`, foreign-key enforcement, and above all the
implicit commit around DDL that makes a migration non-atomic and forces every migration
file to be individually idempotent. SQLite would have been far easier to arrange, would
have gone green, and would have proved none of that — it has transactional DDL, so the
idempotence rule that the whole migrator is built around would have looked like
superstition.

Booking, settings and notification repositories are named in the original scope of
`sql:integration` and are **not** covered, because they do not exist. The gate widens
when they arrive.

---

## 5. Declared but not yet executable

Each gate below is declared in `scripts/validate.mjs` with its reason and its intended
assertion, so the gap is inspectable rather than absent.

### Stage 8 — HTTP smoke

Against a running origin, after deployment: `GET /api/health`; `GET /api/content` with
its ETag, then a conditional request returning 304 with an empty body; an unknown
`/api/*` path returning the **JSON** 404 envelope rather than HTML; a wrong method
returning 405 with `Allow`; HTTP→HTTPS redirect and security headers; and `/` returning
fully populated HTML containing the published content under a `published-<revision>`
ETag; plus `/admin` deep links and `/reservation` resolving as the routing table says.

What is still missing after Package 2.1 is narrower than it was, and worth stating
precisely. The routing rules and the injection are now covered offline by `php:routing`
and `php:public-page`, which run against the same table `.htaccess` is generated from.
What no offline gate can prove is that **Apache actually applies that file** — that
`mod_rewrite` is enabled, that `AllowOverride` permits these directives, and that the
host resolves `DirectoryIndex disabled` the way the rules assume. That is the gap this
stage closes, and it cannot be closed before there is a host.

Smoke tests assert the contract, not the copy. They must pass identically against a
freshly deployed site with default content.

### Stage 9 — Browser scenarios

Critical paths only — enough to catch a broken release, few enough to stay trustworthy:

- **Public**: published content renders; navigation deep links land below the fixed
  navbar; gallery and Instagram links resolve; layout holds at phone, tablet and
  desktop widths.
- **Admin**: an unauthenticated deep link redirects to login; login succeeds and rejects
  bad credentials without enumerating users; an edit saves to the server draft; publish
  updates the public site; logout invalidates the session **server-side**.
- **Booking**: a request submits, validates, persists, appears in admin and enqueues its
  notifications; invalid input is rejected without losing entered data.

### Stage 10 — Security and configuration

- No secret is web-reachable: `config/`, `data/`, `app/`, `var/`, `backups/` and any
  `.env`, `.json`, `.log` or VCS path under the document root return 404/403.
- Directory indexing is off; PHP execution is disabled under `media/`.
- Security headers present: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, CSP.
- `config/` files are mode `0600` and owned by the application user.
- Admin cookies are `HttpOnly`, `Secure`, `SameSite=Strict`.
- No dependency carries a known critical advisory (`npm audit`, `composer audit`).

This stage runs against a deployed host and is the one gate that is allowed to use the
network. It is therefore reported separately and never gates a local run.

---

## 6. Release policy

A V1 release requires:

1. `npm run validate` exits 0 — every executable gate PASS.
2. Stages 7–10 are executing, not NOT RUN, and green. **NOT RUN blocks a V1 release.**
3. A restore rehearsal has been performed and recorded (`docs/hetzner-target-architecture.md` §10).

Local development requires only stages 1–6 — which, since Package 1.2, includes the
full PHP conformance replay. The distinction is deliberate: contributors
are not blocked by infrastructure that does not exist yet, and nobody can mistake that
for the release bar.

Stage 7 sits between the two since ESZ-023. It is not infrastructure that does not
exist — the schema and both suites are committed — so a contributor touching SQL is
expected to run it, and running it needs nothing more than a throwaway MySQL:

```
ESZTER_TEST_DB_DSN='mysql:host=127.0.0.1;port=3306;dbname=eszter_test;charset=utf8mb4' \
ESZTER_TEST_DB_USERNAME=eszter ESZTER_TEST_DB_PASSWORD=… \
npm run validate
```

Without those variables the two gates report NOT RUN, which is still not a pass and
still blocks a release.

---

## 7. Extending the policy

Adding a gate:

1. Declare it in `scripts/validate.mjs` with its stage, its `proves` statement, and
   either a command or a NOT RUN reason.
2. Document it in §4 or §5 above.
3. **Prove it fails.** Introduce the defect it targets and confirm the gate goes red.
   An unverified gate is an assumption with a green checkmark.

Removing or weakening a gate is a deliberate, documented decision — never a silent edit
to make a build pass.
