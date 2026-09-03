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
| **1. Static integrity** | authoritative dependency audits, lockfile sync, typecheck, frontend lint | Executable |
| **2. Contract artifacts** | `contracts:verify:generated` | Executable |
| **3. Contract semantics** | `contracts:test` — parity corpus, rule coverage, refinement census | Executable |
| **4. Frontend behaviour** | `front:test` | Executable |
| **5. Build** | contracts `dist/`, frontend production export, deterministic production deployment artifact | Executable |
| **6. PHP validation** | composer validate, lint, static analysis, unit tests, parity-corpus replay, full `http-contract.json` replay, media, booking domain, document-root routing, sensitive-file permission enforcement (`security:filesystem`) | Executable |
| **7. SQL** | migration, integration and notification queue tests | Executable **when `ESZTER_TEST_DB_DSN` names a disposable MySQL database**; NOT RUN otherwise |
| **8. HTTP smoke** | local PHP server plus deployed-origin checks | Local executable; deployed origin **Not run** |
| **9. Browser scenarios** | admin-preview CSP, CMS media pipeline; public, full admin and booking | Focused CSP/media proofs executable; broader scenarios **Not run** |
| **10. Security and configuration** | deployed exposure, headers and permissions | **Not run** |

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

`security:dependencies` is the ESZ-084 advisory gate. It runs Composer against the
complete lock and the exact `--no-dev` production set, and runs npm against both
the contracts and frontend locks with and without development dependencies. It is
online by design: a cached advisory snapshot is not authoritative. Tool versions
and counts are printed, registry/tool failures fail closed, and any advisory or
abandoned Composer package fails. The dated finding and remediation record is in
`docs/security-review-v1.md`.

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

Since ESZ-063/064/065 it also covers the availability editor: the weekly set travels as
one body with no client-side id, reads carry no CSRF header and mutations do, browser
prevalidation attributes every rule the server enforces to the row that broke it, an
exception replaces rather than merges with the weekly windows and removing it restores
them, and the editor is proved to render server-returned state, confirm destructive
changes, and keep its `aria-invalid` / `aria-describedby` error wiring and its focus
moves. What it does not prove is any of that in a real browser — that is `browser:admin`
in stage 9, which stays NOT RUN.

Since Package 3.2 it also covers the admin client against a stub `fetch`: what the API
client sends (the frozen paths, the CSRF header, `expectedRevision` on every write, and
`source: "published"` on a reset), how it classifies what comes back (401 expiry, 403
stale token, 409 with and without a revision header, 400 validation, a malformed 200,
a transport failure), the draft state machine's refusal to advance a revision on a
failed write, the sanitisation of `?next`, and the demotion of `localStorage` to an
explicit backup that is never read on load and never holds a session or CSRF secret. Since
ESZ-130 it also classifies 429 `RATE_LIMITED` as a distinct recoverable `rate-limited`
failure: a throttled anonymous session bootstrap renders as the unavailable state with a
manual retry, never as an auth result, and is never an expiry.

Since ESZ-136 the `Retry-After` those refusals carry is parsed in one shared frontend
module: only ASCII whole seconds are recognised, a usable delay is honoured up to a
documented 900-second client bound (every frozen bucket's widest refusal is one
emission interval, at most 720 seconds), and a missing, malformed, negative or absurd
value never becomes a trusted timer while the refusal stays explicitly rate-limited.
The login form, the availability refresh and the booking confirmation each render
rate-limit copy, keep their retry control closed until the trusted deadline with an
exact French countdown, and re-enable a manual retry when it passes — nothing resubmits
automatically, a 429 is never classified as a credential, slot, validation, network or
generic-server outcome, and booking creation's network `uncertain` meaning survives.

Since ESZ-139 the admin booking calendar sends the booking's own `updatedAt` back as
`expectedUpdatedAt` on every mutation — move, cancel and contact update — and tells the
two frozen 409 conflict codes apart even though both classify as `conflict`: a
`REVISION_CONFLICT` means the tab held stale data and is never auto-retried (the booking
is reloaded by reference, the UI keeps working from the authoritative reloaded row with
explicit stale-data copy, and for a move the slots refresh only when the reloaded booking
is still confirmed), while a `SLOT_UNAVAILABLE` keeps its own slot copy and is never
presented as stale data. No conflict path claims a cancelled or saved outcome, and the
client's `conflict` failure carries the frozen `errorCode` that makes the distinction
possible without widening the HTTP envelope.

Since Package 3.3 it also covers the media panel: that an upload sends `FormData` with
**no** explicit `content-type` — a hand-set `multipart/form-data` carries no boundary
and arrives as zero parts — that an oversized file is refused before a request is made,
that 413, 409 `MEDIA_REFERENCED`, 404 and 400 are four distinguishable failures rather
than one, that a media 409 is never read as a revision conflict, that the asset list
only ever moves on a server confirmation, that deleting is two steps and a refusal
removes nothing, and that a whole upload/delete/select session leaves the draft
revision exactly where it was.

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

`front:budgets` (ESZ-085) measures the gzipped transfer weight of every route —
the document plus every stylesheet and script it references — plus the shared CSS
and JavaScript totals, against ceilings declared in `front/scripts/verify-budgets.mjs`.

The budgets sit a few per cent above what the current build produces, which is the
whole design: this is a **ratchet**, not an audit. It is silent today and speaks the
moment something grows, which is the regression worth catching automatically — a
dependency added to a shared layout, a library pulled into the admin bundle, an
image inlined as a data URI. Each of those is invisible in review and permanent
once shipped. A budget with room for a doubling would prove nothing, so raising one
is a deliberate edit in the same commit as the growth.

It measures gzip because that is what is transferred; raw size overstates the cost
of minified code and understates the cost of anything already compressed. It is
**not** a Lighthouse score and does not claim to be one — no browser is involved,
and Stage 9 stays NOT RUN.

`deployment:artifact` then stages only the export and PHP production runtime, installs
the Composer lock with `--no-dev`, writes a file/digest/mode manifest and builds the
archive twice to prove deterministic bytes. It rejects secrets/config, Node modules,
tests, caches, source maps and private trees below `public_html`; it also requires
Symfony Mailer, all migrations, the migration CLI and the explicit SMTP runner. This is
an offline structural proof, not a claim that Apache has served the result.

### Stage 6 — PHP validation

| Gate | Command | Proves |
| --- | --- | --- |
| `php:dependencies` | existence check on `php/vendor/autoload.php` | The PHP dependencies are installed. `php/vendor/` is not committed, so a fresh clone fails here with the command to run rather than four gates later on a missing binary. Per §2 this is a FAIL, not a NOT RUN: the subject exists and the tooling is merely absent. |
| `php:composer-validate` | `composer validate --strict` | `composer.json` is valid and in sync with `composer.lock`. |
| `php:lint` | `php bin/lint.php` | `php -l` over **every** PHP source file, including files no test happens to autoload — a parse error there is invisible to PHPUnit and fatal in production. |
| `php:static-analysis` | `php bin/static-analysis.php` | PHPStan at **level max** over `src/` and `bin/`, **level 6** over `tests/`, plus PSR-12. Both levels are pinned in committed configs, so the gate cannot drift by dependency upgrade. |
| `php:unit` | `vendor/bin/phpunit --testsuite eszter` | Configuration fail-fast — including ESZ-027's production refusals: a missing `database` block, a placeholder or empty DB password, a non-MySQL DSN, `session.cookieSecure: false`, and a config file readable by group or others. Plus contract-artifact digest verification, atomic JSON storage (temp-write, fsync, rename, size cap, locking, idempotent seeding, no silent replacement of an invalid file), the HTTP layer against `http-contract.json`, ESZ-025/026's auth invariants, and Package 3.1's admin content invariants — the shared revision sequence, publish atomicity and idempotence, ETag invalidation across `/` and `/api/content`, draft/published isolation, conflict-leaves-storage-untouched, and real two-process concurrency against one content directory. The suite is named explicitly rather than left to the default, so this gate cannot start depending on a database server. |
| `php:parity-corpus` | PHPUnit, contract suites | The PHP validator replays `contracts/generated/parity-corpus.json` with **identical** accept/reject outcomes and **identical** issue paths, every rule declared in `semantic-rules.json` is implemented, and structural validation is driven by the generated JSON Schema rather than a second hand-written schema. |
| `php:http-contract` | PHPUnit, HTTP suites | The full `http-contract.json` case list against the PHP HTTP layer: statuses and `Allow` headers, the closed error envelope, request-id generation and echo, `ETag` / `If-None-Match` / 304, cache headers, opaque storage failures, the over-limit body outcome and the bootstrap-failure envelope. Since ESZ-021 this includes `/`; since Package 3.1 it includes the three `/api/admin/content/*` paths, their `409 REVISION_CONFLICT` outcomes, the `x-content-revision` header and the per-case assertion that storage is byte-identical after every rejected write. The artifact's exemption set is asserted to be **empty**. Since ESZ-063/064/065 it also replays the availability administration and summary surface: all four routes refuse an anonymous caller, the two mutations refuse a session without CSRF, the two reads need no token, and an inverted window, an overlapping weekly set, an empty open exception and a spring-forward boundary are each refused with the frozen envelope. |
| `php:public-page` | PHPUnit, `PublicPageBootstrapTest` | The injector rewrites only the two bootstrap elements and leaves the rest of the export byte-identical; it locates them by `id` rather than by a remembered opening tag; a missing element raises instead of producing a half-injected page; the payload stays valid JSON that no editorial string can break out of; and the appearance block emits exactly the custom properties the contract declares, dropping any value that is not a validated hex colour. |
| `php:media` | PHPUnit, `MediaUploadTest\|MediaLibraryTest` | ESZ-036/037 against real image bytes generated by the suite. Every allowed format is stored under a cryptographically random server-generated name whose extension comes from the verified type, so a client filename reaches no path. A PHP script wearing JPEG magic bytes, an SVG, a GIF, a truncated JPEG, a polyglot whose two parsers disagree, and a header declaring 1.6 × 10^10 pixels are all refused — the last before any decoder runs. The served derivative is the server's own re-encode, so EXIF and a payload appended after EOI are absent from it. An over-limit upload is 413 while the 64 kB JSON limit is unchanged on every other route, and PHP's own silent `post_max_size` discard is recovered as a 413 rather than reported as a missing file. Every refusal leaves no intake file, no original, no file under `/media/` and no catalogue entry. A delete is refused with 409 while **either** the authoritative draft or the published document references the asset, and refusing removes nothing; a `$_FILES` entry naming a file the request did not upload is refused; a corrupt catalogue is never silently replaced. ESZ-135 freezes every standard PHP upload error code through the real route: `UPLOAD_ERR_INI_SIZE`/`FORM_SIZE` stay 413 `PAYLOAD_TOO_LARGE`, `NO_FILE`/`PARTIAL` stay 400 `VALIDATION_FAILED`, and `NO_TMP_DIR`/`CANT_WRITE`/`EXTENSION` plus any unrecognised non-zero code answer the opaque generic 500 `INTERNAL_ERROR` — never `VALIDATION_FAILED` — logged at error level with a stable classification and the PHP upload error code, leaking no error number, path or filename into the response, and leaving zero managed artifacts; the silent `post_max_size` discard recovery remains a distinct warn-level 413 and is not conflated with host faults. |
| `php:booking` | PHPUnit, `BookingDomainTest\|AvailabilitySlotEngineTest` | ESZ-040 through ESZ-045 without SQL: stable service/state contracts, weekly windows, strict exception replacement, fixed midnight grid, buffer and occupancy boundaries, bounded dynamic generation, spring-gap omission and explicit fall-fold selection. |
| `php:security` | PHPUnit, `RateLimitPolicyTest\|RateLimitGuardTest\|SecurityHeadersTest\|StorageLimitReconciliationTest\|MediaLibraryCapTest` | ESZ-084 without a database. The frozen rate-limit policy is **refused** rather than silently weakened when this implementation cannot honour it — a limiter that degrades quietly is indistinguishable from one that works until the day it matters. A login charges the caller's address before the submitted identity, and stops at the first refusal, so a flood from one source cannot spend the operator's budget and lock them out of their own site. A throttled login is byte-identical whether or not the address names an account, so throttling cannot become the enumeration oracle `auth.loginFailure` exists to prevent. A forwarding header never changes which bucket a request is charged to, which is the bypass the whole design closes. The generated `.htaccess` sends CSP, Permissions-Policy and the baseline headers with `always` — so they reach 404s and 500s, the responses an attacker sees most — names no external origin and carries no wildcard, and confines `'unsafe-inline'` to script and style. The content read guard is proved to stay strictly **above** the request limit, which is the inequality that stops a save being accepted, written and then refused by the very next read. And the media catalogue cap is enforced before the write, so the one cap a caller can actually reach can no longer wedge the delete that would have shrunk it. ESZ-130 adds the one guarded GET: the anonymous `GET /api/auth/session` read is charged to `auth.session.bootstrap.address` only when no live session was loaded and always before the route could create a row — a refused bootstrap is the frozen 429 with `Retry-After` and no cookie, live-session reads are never charged, and the guard entry can never charge a non-session GET or a POST. |
| `security:filesystem` | PHPUnit, `AtomicJsonFileTest\|LoggerTest\|MediaIngestFileModeTest\|MediaLibraryFileModeTest` | ESZ-103's sensitive-file permission boundary, on real temporary-filesystem modes and with negative injection, with no network, MySQL or browser required. Atomic JSON finals are published at 0640 and a write whose mode restriction fails — or was accepted but did not take effect, a chmod call alone being no proof — leaves the previous target byte-identical and removes its temp file. Upload intake is restricted to 0600 and a failed restriction catalogues nothing, converging through the ingest's own cleanup; stored private originals are 0640 and served derivatives stay the intentional 0644, each failed restriction unwinding every placed file. Log files are born, and pre-existing wider ones corrected, to 0600 under a hostile process umask that is restored on every path, and a log whose restriction cannot be established degrades to silence rather than crashing the caller or knowingly writing into a wider file. A pre-existing over-permissive sensitive target is corrected when possible and otherwise follows the component's fail/degrade contract. The backup-archive half of the boundary is proved against real MySQL by `sql:backup-restore`. |
| `php:backup` | PHPUnit, `TarArchiveTest\|BackupManifestTest` | ESZ-083's archive format and integrity record, offline. The archive is a hand-written ustar writer because neither `ext-phar` nor a `tar` binary can be assumed on the target host, and that trade is only reasonable while the format is proved rather than believed: entries round-trip byte for byte, GNU tar reads what it produces, and writing is deterministic so two backups of an unchanged deployment agree. A truncated archive, a corrupted header, an unsupported entry type and every path that would escape the destination are each refused. The manifest catches a missing entry, an altered one, an entry of the wrong length, an **undeclared extra** file, a rewritten digest and an unknown format version. |
| `php:notifications` | PHPUnit, `NotificationPolicyTest\|NotificationCatchUpTest` | ESZ-070/071/072 without SQL. The frozen channel, type and status enums; a status graph whose four terminal states — `sent`, `failed`, `skipped`, and the retention sweep's `retired` (ESZ-140) — have no way back out and whose `processing` is reachable only from `pending`; deterministic clamped backoff and the exact attempt at which retrying stops. The diagnostic code pattern is proved unable to express an address, a phone number, a message fragment or a bearer token, which is what makes "no customer data in the stored error" structural rather than a review habit. The log allowlist and the declared forbidden-field list are proved disjoint, and a forbidden **value** is proved unable to ride in on an allowed key. The migration file is read and checked to restate every frozen set and bound and to use `ON DELETE RESTRICT` rather than `CASCADE`. Finally the catch-up rules: a reminder one minute inside its grace window is deliverable and one minute outside it is not, only time-sensitive types expire at all, a disabled channel is reported as disabled even when the window also closed, and re-enabling a channel after twenty declined windows neither backfills them nor produces a burst. |
| `php:routing` | PHPUnit, `DocumentRootRoutingTest` | `/api` resolves before anything can shadow it; static assets are served directly; `/admin` deep links survive a refresh; `/reservation` resolves exactly to its exported HTML while unknown subpaths 404; `/` is never resolved as a static file; every declared rule is reachable; and the committed `.htaccess` is byte-identical to what the routing table renders, using only directives that are legal in that context. Since ESZ-036 it also executes `media/.htaccess`'s managed-asset whitelist through PCRE — the same engine Apache uses — against staging names, double extensions, case variants and an SVG. |

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
| Live provider acceptance and mailbox receipt | Package 7.2 proves SMTP message construction and failure classification with a no-network mailer double. It deliberately does not contact a deployment-owned SMTP account or assert delivery into a real mailbox. SMS is outside Package 7.2 and remains unimplemented. |
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
| `sql:migrations` | `vendor/bin/phpunit --testsuite sql-migrations` | Every migration applies repeat-safely and in order. Booking coverage proves table shape, constraints, exception-window/history foreign keys, the singleton serialization row and indexes on real MySQL, plus the deliberate absence of a generated-slot table. ESZ-130 adds migration 0013: the guarded ADD KEY on `admin_sessions.absolute_expires_at` re-runs cleanly after a partial application, and EXPLAIN proves both session-deadline indexes (0002 idle, 0013 absolute) answer the bounded GC deletes as index-range reads with no table scan and no filesort. |
| `sql:integration` | `vendor/bin/phpunit --testsuite sql-integration` | Admin auth and the booking backend against real MySQL, including HTTP auth/CSRF, availability, atomic create/move/cancel/history and Package 6.2 availability administration. ESZ-087 drives two independent PHP processes through the production Kernel and `POST /api/bookings` for the same valid slot: exactly one 201 confirmation, one 409 `SLOT_UNAVAILABLE`, one confirmed booking/history occurrence and one confirmation/reminder job pair. ESZ-074 additionally proves lifecycle jobs commit atomically with booking/history, duplicate-safe confirmation/cancellation identities, exact T−24h reminders, move supersession and rescheduling, terminal skips outside catch-up, cancellation retirement and rollback of all three tables when a producer fails. ESZ-130 bounds the anonymous-session bootstrap end to end: repeated no-cookie reads admit exactly the frozen burst (10) then answer 429 `RATE_LIMITED` with `Retry-After` and no `Set-Cookie`, adding zero `admin_sessions` rows; invented, malformed and expired cookies are each a fresh charge and never adopt the supplied id; a retained cookie reuses and touches one anonymous session and spends none of the new-bootstrap allowance; the bounded two-pass sweep drains 900 idle- and absolute-expired rows through real bootstrap wiring in 400/400/100 batches, leaves live rows untouched, converges to zero changes, and answers the opaque 500 with no row and no cookie when a real MySQL SIGNAL fails the sweep DELETE; an admitted bootstrap cookie and CSRF still log in while cross-paired cookie/token is refused; and neither limiter rows nor the debug log expose the address, any session id or any CSRF token. |
| `sql:rate-limits` | `vendor/bin/phpunit --testsuite sql-rate-limits` | ESZ-084 against real MySQL, because every guarantee the limiter makes is a property of the **store** rather than of the algorithm — an in-memory double would satisfy all of them by construction and prove none. Allowance is spent across separate charges and survives them, which is the whole point on a runtime where each request is its own process; it is restored exactly one emission interval later and not a millisecond earlier; a refused charge writes nothing, so hammering a full bucket cannot lengthen its own penalty; two subjects and two scopes never share a row; an idle bucket recovers its whole burst but accumulates no credit beyond it; no address or e-mail is stored in clear; a row is never sweepable while it is still refusing; and two independent operating-system processes racing the last allowance admit exactly one. ESZ-130 adds the anonymous-session bootstrap bucket to the same store: its frozen rule (30 per hour, burst 10, one 120-second emission interval) admits exactly ten charges at one instant, refuses the eleventh, restores one unit exactly one emission interval later, and two independent processes racing its last allowance still admit exactly one. |
| `sql:backup-restore` | `vendor/bin/phpunit --testsuite sql-backup-restore` | ESZ-083's restore proof plus ESZ-097's snapshot proof. A realistic deployment is restored into a **second empty database and directory** and checked through SQL/content/media. A controlled callback mutates two tables between their reads and proves the dump and row counts remain on one MySQL consistent snapshot. A backup worker then pauses after SQL export, a second process attempts one correlated SQL + draft mutation, and the archive is proved wholly pre-mutation while the live deployment becomes wholly post-mutation after the barrier releases. Integrity, exclusions and restore refusals remain covered. |
| `sql:notifications` | `vendor/bin/phpunit --testsuite sql-notifications` | ESZ-070/071/072 against real MySQL, because almost none of it is true on any other engine. A repeated enqueue resolves to the same row and does not reschedule it, while a key reused for a different booking is refused rather than silently ignored. A claim takes a durable lease, charges one attempt and is invisible to a second claim; a job not yet due, or whose channel has no transport, is never claimed. Delivery succeeds exactly once and `sent` is terminal. Transient failures retry on the frozen 60/120/240/480-second backoff and become terminal on the fifth attempt; a permanent refusal is terminal on the first; a transport throwing anything else is classified as transient and its message reaches neither storage nor the log. An abandoned lease is recovered one second after it expires and not one second before, without forgiving the attempt it charged, so a job that kills every runner exhausts its budget instead of looping. A runner whose lease expired mid-delivery cannot record a delivery it no longer owns. One run claims at most its batch. A stale reminder is retired before it can be claimed **and** re-checked after, and never delivered; a non-time-sensitive job is never retired for being old; a disabled channel produces terminal skips so a later re-enable finds nothing pending. No customer name, address, phone, note or database credential appears in any log line, and every key on every line is on the frozen allowlist. Two independent operating-system processes blocked on the same row prove exactly one claims, exactly one delivers, and the row records exactly one attempt. |

Isolation is the requirement, not a preference:

- Tests run against a **disposable** database. `TestDatabase` refuses any database whose
  name does not end in `_test`, because these suites drop and truncate tables and a
  naming rule is a cheap way to make pointing them at something real impossible rather
  than merely discouraged.
- Each `sql:integration` test runs inside a transaction that is rolled back afterwards.
  `TRUNCATE` is deliberately not used per test: on MySQL it commits implicitly and would
  defeat the rollback it was meant to help.
- `sql:rate-limits` and `sql:backup-restore` are the two exceptions, and both are
  exceptions on purpose. A rate-limit charge must **never** be transactional — the
  routes it guards open their own transactions, and a charge folded into one would be
  rolled back by the failure it was meant to bound, so a script could retry forever at
  zero cost. A restore runs migrations, whose DDL commits implicitly on MySQL and would
  silently end an enclosing transaction. Both suites truncate instead, and both are
  separate suites so that a future "wrap everything in a transaction" change cannot
  quietly defeat the property they exist to prove.
- Fixtures are explicit. No test depends on rows another test created.

**MySQL, not SQLite.** The engine is what is under test: `utf8mb4` collation semantics,
`ON DUPLICATE KEY UPDATE`, `GET_LOCK`, foreign-key enforcement, and above all the
implicit commit around DDL that makes a migration non-atomic and forces every migration
file to be individually idempotent. SQLite would have been far easier to arrange, would
have gone green, and would have proved none of that — it has transactional DDL, so the
idempotence rule that the whole migrator is built around would have looked like
superstition.

Package 4.3 widens `sql:integration` to the public/admin booking HTTP surface, durable
history and real concurrent cross-service creation. Package 7.1 adds a third SQL gate,
`sql:notifications`, and gives `system_settings` its first key,
`notifications.channels`. Package 7.2 adds the booking e-mail producer and SMTP transport;
SMS and live-provider receipt remain separate work.

Since ESZ-139 the gate also proves the per-booking optimistic-concurrency token against
real MySQL: update, move and cancel require `expectedUpdatedAt` and compare it
byte-for-byte with the current row under the authoritative row lock before any write,
history append or notification scheduling. A stale contact update cannot overwrite a
newer one; stale moves and cancels leave row, history and notification jobs untouched;
move-then-stale-cancel and cancel-then-stale-move are both refused; two real concurrent
processes replaying the same token yield exactly one success and one
`BookingRevisionConflictException`; the same frozen millisecond or a backward application
clock still mints a strictly newer canonical `updatedAt` (one derived instant, with
`updated_at`, `state_changed_at` and `cancelled_at_utc` agreeing); a fresh re-read token
unblocks the next mutation; and the HTTP surface maps the refusal to 409
`REVISION_CONFLICT` with the closed envelope and no internal state, a token-less mutation
being a schema 400.

---

## 5. Runtime smoke and deployment-owned gates

Each gate below is declared in `scripts/validate.mjs`. The repository-local PHP smoke
and the focused admin-preview CSP, media-pipeline, admin-auth and public browser proofs
are executable; checks that require a deployed origin or the broader admin/booking
browser workflows remain NOT RUN with their reason, so the gap is inspectable rather
than absent.

### Stage 8 — HTTP smoke

`smoke:local-php` starts the documented `npm run php:serve` implementation on an
ephemeral loopback port after the build stage. It proves that `/` returns the injected
Eszter export, one hashed frontend asset resolves, `/api/health` crosses the production
PHP front controller, unknown public and API routes retain their HTML and JSON 404
contracts, and the server logs no PHP routing/bootstrap fatal. The process is always
terminated at the end of the gate.

The separate `smoke:deployed-http` gate remains NOT RUN until an origin exists. It adds
`GET /api/content` ETag revalidation, a wrong method and `Allow`, HTTP→HTTPS redirect,
security headers, `/admin` deep links and `/reservation` under the real host.

The remaining deployed-origin gap is the production host configuration. The local
smoke, `php:routing` and `php:public-page` exercise the built-in-server adapter, routing
table and injection. `browser:admin-preview-csp` separately proves Apache applying the
generated `.htaccess` in a controlled local production-style harness. It cannot prove
that the deployed host enables the same modules and `AllowOverride`, terminates TLS or
has the intended filesystem layout; `smoke:deployed-http` retains those obligations.

Smoke tests assert the contract, not the copy. They must pass identically against a
freshly deployed site with default content.

### Stage 9 — Browser scenarios

`browser:admin-preview-csp` runs the built export under Apache with the committed
generated `.htaccess`, then drives headless Chrome. It requires local Docker and
`google-chrome` (overridable with `ESZTER_CSP_APACHE_IMAGE` and
`ESZTER_CSP_CHROME`). The gate checks the CSP received by both the parent and the real
`/admin/preview` iframe, requires `frame-src 'self'`, rejects broader frame authority,
and proves an external iframe raises a `frame-src` violation. Its temporary document
root, browser profile and container are removed on every outcome.

`browser:media-pipeline` runs the built export and PHP application against its own
temporary MySQL container, content store, generated development credential and Chrome
profile. It uploads a real PNG through the admin media input, selects the returned
managed `/media/med_…` path, proves all eleven Hero/Services/Gallery/About images decode
in the live preview, saves and publishes through the real server workflow, then proves
the public page decodes the same path with the published alt text. Before the edit it
also checks all eleven null fallbacks and a deliberately broken Hero source. The gate
removes its container, credential, profile, content and uploaded derivative on every
outcome; it does not use the ordinary development database or browser profile.

`browser:admin-auth` runs the same isolated stack (temporary MySQL container, real PHP
built-in server over the static export, generated development credential, headless
Chrome) for the ESZ-101 sign-out and rotation semantics. It proves three scenarios:
an operator password rotation revokes the signed-in browser's session — the editor
reloads to the signed-out screen, the old credential is refused indistinguishably and
the new one signs in; a logout whose server-side record deletion fails (a real MySQL
trigger SIGNAL) keeps the browser on the authenticated admin surface with the retryable
error and no signed-out claim, while the captured session id keeps authorising until
the retry completes once the trigger is removed; and a clean logout lands on
`/admin/login` with the session row gone and the pre-logout cookie unable to authorise.
The gate removes its container, profile and credentials on every outcome.

`browser:public` runs the built export, the PHP front controller and an isolated
MySQL under **Apache applying the committed generated `.htaccess`** (a disposable
document root and containers; the same requirement set as the other browser gates,
plus `openssl`). It proves the public scenario below end to end — published content
renders, navigation clicks and direct deep links land below the fixed navbar, gallery
and Instagram links resolve exactly as `/api/content` declares them, and the layout
holds at phone, tablet and desktop widths — and adds the ESZ-104 image-policy proofs
under the served CSP: a same-origin managed image loads and decodes with no CSP
violation, a cross-origin HTTPS image from a local self-signed TLS fixture loads and
decodes under scheme-wide `https:` (browser trust bypass scoped to the disposable
Chrome profile), an `http:` media source is refused as contract-invalid through the
real draft-save envelope (`400 VALIDATION_FAILED`, draft unchanged) before any
publication, and an intentionally injected `http:` `<img>` is CSP-blocked while the
same HTTP fixture origin demonstrably serves images outside the page. All fixtures
are local; no request leaves `127.0.0.1`. The gate removes its containers, network,
profile, credentials, TLS material and document root on every outcome.

Those focused proofs do not implement the broader `browser:admin` and `browser:booking`
contracts below.
Critical paths only — enough to catch a broken release, few enough to stay trustworthy:

- **Admin**: an unauthenticated deep link redirects to login; login succeeds and rejects
  bad credentials without enumerating users; an edit saves to the server draft; publish
  updates the public site; logout invalidates the session **server-side**.
- **Booking**: a request submits, validates, persists, appears in admin and enqueues its
  notifications; invalid input is rejected without losing entered data. Package 7.2 now
  covers the enqueue half against MySQL; this browser scenario still proves the composed flow.

### Stage 10 — Security and configuration

- No secret is web-reachable: `config/`, `data/`, `app/`, `var/`, `backups/` and any
  `.env`, `.json`, `.log` or VCS path under the document root return 404/403.
- Directory indexing is off; PHP execution is disabled under `media/`.
- Security headers present: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, CSP.
- `config/` files are mode `0600` and owned by the application user.
- Admin cookies are `HttpOnly`, `Secure`, `SameSite=Strict`.

Dependency advisory checks moved to the executable Stage 1
`security:dependencies` gate in the ESZ-084 closure. Stage 10 runs against a deployed
host, so it is reported separately and never gates a local run.

---

## 6. Release policy

A V1 release requires:

1. `npm run validate` exits 0 — every executable gate PASS.
2. Stages 7–10 are executing, not NOT RUN, and green. **NOT RUN blocks a V1 release.**
3. A restore rehearsal has been performed and recorded (`docs/hetzner-target-architecture.md` §10).

Local development requires the executable local gates through stage 8 — including the
full PHP conformance replay and real built-in-server smoke. The distinction is deliberate: contributors
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

Without those variables the SQL gates report NOT RUN, which is still not a pass and
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
