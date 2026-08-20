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
| **7. SQL** | migration tests, integration tests | **Not run** |
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
appearance and contrast rules, public/admin module isolation, local-draft semantics,
and responsive behaviour.

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
| `php:unit` | `vendor/bin/phpunit` | Configuration fail-fast, contract-artifact digest verification, atomic JSON storage (temp-write, fsync, rename, size cap, locking, idempotent seeding, no silent replacement of an invalid file), and the HTTP layer against `http-contract.json`. |
| `php:parity-corpus` | PHPUnit, contract suites | The PHP validator replays `contracts/generated/parity-corpus.json` with **identical** accept/reject outcomes and **identical** issue paths, every rule declared in `semantic-rules.json` is implemented, and structural validation is driven by the generated JSON Schema rather than a second hand-written schema. |
| `php:http-contract` | PHPUnit, HTTP suites | The full `http-contract.json` case list against the PHP HTTP layer: statuses and `Allow` headers, the closed error envelope, request-id generation and echo, `ETag` / `If-None-Match` / 304, cache headers, opaque storage failures, the over-limit body outcome and the bootstrap-failure envelope. Since ESZ-021 this includes `/`, and the artifact's exemption set is asserted to be **empty**. |
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
- **Exemptions are data, not skips.** `unknown.get.rootNotFound` is exempt for PHP —
  the front controller is mounted at `/api` and owns nothing else, so on the target
  host `/` is the static site and a 404 there would be a bug. The exemption lives in
  `http-contract.json`, the suite asserts there is exactly one, and a skipped test can
  therefore never be mistaken for a migration difference.

What stage 6 does **not** yet prove, and says so rather than being silently absent:

| Not covered | Why |
| --- | --- |
| Auth, media, content injection, notification queue | `php:unit` covers what exists. Those subjects do not exist yet; the gate widens as they arrive. |

---

## 5. Declared but not yet executable

Each gate below is declared in `scripts/validate.mjs` with its reason and its intended
assertion, so the gap is inspectable rather than absent.

### Stage 7 — SQL

Isolation is the requirement, not a preference:

- Tests run against a **disposable** database created for the run and dropped after —
  never a shared, never a production, never a developer's working database.
- `sql:migrations` applies every migration to an empty database in declared order,
  asserts re-running is a no-op, and asserts `schema_migrations` ends consistent.
- `sql:integration` seeds from migrations and exercises the admin, booking, settings and
  notification repositories, each test wrapped in a transaction that is rolled back, so
  cases cannot leak into one another.
- Fixtures are explicit and committed. No test may depend on rows another test created.

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
