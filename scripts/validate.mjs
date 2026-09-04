#!/usr/bin/env node
/**
 * ESZ-005 — the single validation entry point.
 *
 * Executes the V1 quality gates in their declared order and reports one of three
 * outcomes per gate: PASS, FAIL or NOT RUN.
 *
 * NOT RUN is never a pass. Gates that depend on components this repository does not
 * contain yet (MySQL, a deployed origin, a browser runner) are declared here with the
 * reason they cannot execute, so the gap stays visible instead of being silently
 * absent. They are printed, counted, and excluded from the success claim.
 *
 * PHP is the only backend as of Package 1.2 (ESZ-015). The Express reference service
 * was retired once `php:http-contract` replayed the same generated artifact green, so
 * there is one implementation of the frozen surface and one gate proving it conforms.
 *
 * Policy: docs/v1-quality-gates.md
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PASS = "PASS";
const FAIL = "FAIL";
const NOT_RUN = "NOT RUN";

/**
 * Ordered gate declarations. Order is the policy: each stage assumes the previous one
 * held, so the first failure is the most informative one available.
 */
const gates = [
  // ── Stage 1 — Static integrity ────────────────────────────────────────────────
  {
    id: "security:dependencies",
    stage: "1. Static integrity",
    cwd: ".",
    command: ["node", "scripts/audit-dependencies.mjs"],
    proves:
      "ESZ-084: the locked Composer and npm dependency sets are checked against the authoritative online advisory registries, both complete and with development dependencies omitted to mirror the production artifact.",
  },
  {
    id: "contracts:lockfile",
    stage: "1. Static integrity",
    cwd: "contracts",
    command: ["npm", "ci", "--dry-run", "--offline", "--no-audit", "--no-fund"],
    proves: "package.json and package-lock.json are in sync; a clean install is reproducible.",
  },
  {
    id: "front:lockfile",
    stage: "1. Static integrity",
    cwd: "front",
    command: ["npm", "ci", "--dry-run", "--offline", "--no-audit", "--no-fund"],
    proves: "package.json and package-lock.json are in sync; a clean install is reproducible.",
  },
  {
    id: "contracts:typecheck",
    stage: "1. Static integrity",
    cwd: "contracts",
    command: ["npm", "run", "-s", "typecheck"],
    proves: "The contract sources type-check.",
  },
  {
    id: "contracts:typecheck:tools",
    stage: "1. Static integrity",
    cwd: "contracts",
    command: ["npm", "run", "-s", "typecheck:tools"],
    proves: "The generator scripts and contract tests type-check.",
  },
  {
    id: "front:lint",
    stage: "1. Static integrity",
    cwd: "front",
    command: ["npm", "run", "-s", "lint"],
    proves: "The frontend passes ESLint, including the Next.js rule set.",
  },

  // ── Stage 2 — Contract artifact integrity ─────────────────────────────────────
  {
    id: "contracts:verify:generated",
    stage: "2. Contract artifacts",
    cwd: "contracts",
    command: ["npm", "run", "-s", "verify:generated"],
    proves:
      "The committed contracts/generated/* artifacts are byte-identical to a fresh regeneration, and manifest digests match. Editing Zod without regenerating fails here.",
  },

  // ── Stage 3 — Contract semantics ──────────────────────────────────────────────
  {
    id: "contracts:test",
    stage: "3. Contract semantics",
    cwd: "contracts",
    command: ["npm", "run", "-s", "test"],
    proves:
      "The parity corpus replays green, every declared semantic rule has a rejecting case, and the refinement census matches. This is the suite a PHP implementation must also pass. ESZ-142 adds the immutable consent-notice catalog tests: entries are unique and bounded-ASCII, every id has an exact text, the current pointer names an entry, the create schema accepts exactly the catalog ids (each issued id, never a text field) and refuses a missing or unknown id and refused consent.",
  },

  // ── Stage 4 — Frontend behaviour ──────────────────────────────────────────────
  {
    id: "front:test",
    stage: "4. Frontend behaviour",
    cwd: "front",
    command: ["npm", "run", "-s", "test"],
    proves:
      "Content encoding integrity, appearance/contrast rules, admin/public isolation, local-draft semantics and responsive behaviour; ESZ-050 through ESZ-055 additionally prove active-service filtering, Paris-local date bounds, authoritative slots, customer validation and consent, exact creation payloads, duplicate-submit prevention, confirmation, stale-slot recovery, preserved failure state and accessible focus movement. ESZ-063/064/065 add the availability editor: the weekly set travels as one body with no client id, reads carry no CSRF and mutations do, prevalidation attributes every server rule to the row that broke it, an exception replaces rather than merges with the weekly windows and removing it restores them, and the editor is proved to render server-returned state, confirm destructive changes and keep its error and focus states. ESZ-130 classifies a 429 RATE_LIMITED response as a distinct recoverable rate-limited failure: the session bootstrap renders it as the unavailable state with a manual retry and never as an auth result, a rate-limited read is never an expiry, and a 429 on the login call is reported as rate-limiting rather than as a server fault. ESZ-136 makes every client honour the frozen Retry-After through one shared parser: only ASCII whole seconds are recognised, any usable delay is capped at the documented 900-second bound, and missing, malformed, negative or absurd values yield no trusted timer while the refusal stays explicitly rate-limited. The login form, the availability refresh and the booking confirmation each show rate-limit copy, keep their retry control closed until the trusted deadline with an exact countdown, and re-enable a manual retry at expiry with no automatic request — and a 429 is never classified as a credential, slot, validation, network or generic-server failure, while booking's network `uncertain` outcome is untouched. ESZ-139 proves the admin booking calendar sends the booking's own updatedAt as expectedUpdatedAt on every move/cancel/update and tells the two frozen 409 conflict codes apart: a REVISION_CONFLICT is never auto-retried — the booking is reloaded by reference, shown with explicit stale-data copy, and move slots refresh only when the reloaded booking is still confirmed — while a SLOT_UNAVAILABLE keeps its own slot copy, and no conflict path claims a cancelled or saved outcome. ESZ-142 proves the consent checkbox renders the frozen catalog's current notice text with no private duplicate in the component, and that the booking request carries that same notice's id beside consentAccepted: true — never notice text — while a missing or unknown id is refused client-side before anything is posted. ESZ-145 proves the split booking surfaces: the calendar's range walk parses and renders current-state facts only, an admin range page whose items carried a history array or whose envelope lacks the page facts is refused as malformed, the mutation transport adopts the returned current-state booking with no history array expected or parsed, and the conflict-reload reference read adopts the authoritative row from the new reference envelope (the booking beside its bounded history page) exactly as before.",
  },

  // ── Stage 5 — Build ───────────────────────────────────────────────────────────
  {
    id: "contracts:build",
    stage: "5. Build",
    cwd: "contracts",
    command: ["npm", "run", "-s", "build"],
    proves: "The contract package emits dist/ for its consumers.",
  },
  {
    id: "front:build",
    stage: "5. Build",
    cwd: "front",
    command: ["npm", "run", "-s", "build"],
    proves:
      "The frontend builds. Under `output: \"export\"` this also refuses middleware, route handlers, `revalidate` and dynamic rendering, so anything needing a Node process fails here rather than on a host that has none.",
  },
  {
    id: "front:export",
    stage: "5. Build",
    cwd: "front",
    command: ["npm", "run", "-s", "verify:export"],
    proves:
      "ESZ-020/050: out/ is deployable without Node. No dynamic route, middleware, rewrite, route handler or server-only dependency survived; every route including reservation.html reached out/ as a file; and out/index.html carries a parseable bootstrap payload and a colours-only appearance block for ESZ-021's PHP injection to rewrite.",
  },
  {
    id: "front:budgets",
    stage: "5. Build",
    cwd: "front",
    command: ["npm", "run", "-s", "verify:budgets"],
    proves:
      "ESZ-085: every route's gzipped transfer weight, and the shared CSS and JavaScript totals, are within declared ceilings. The budgets sit just above what the current build produces, so the gate is a ratchet: a dependency added to a shared layout, a library pulled into the admin bundle or an image inlined as a data URI fails here rather than shipping. It is not a Lighthouse score and does not claim to be one — no browser is involved.",
  },
  {
    id: "deployment:artifact",
    stage: "5. Build",
    cwd: ".",
    command: ["node", "scripts/build-production-artifact.mjs"],
    proves:
      "ESZ-080/082: the static export, generated contracts, PHP runtime, migrations and production-only locked Composer dependencies form a deterministic archive; only public_html is web-facing, no secret/config or source/test/cache artifact is included, Symfony Mailer and both production operator entry points are present, and Node is build-time only.",
  },

  // ── Stage 6 — PHP validation ──────────────────────────────────────────────────
  {
    id: "php:dependencies",
    stage: "6. PHP validation",
    cwd: "php",
    // php/vendor/ is not committed, so a fresh clone must install first. Failing
    // here with the command to run beats four later gates failing on a missing
    // binary. Per policy this is a FAIL, not a NOT RUN: the subject exists and the
    // tooling is simply absent.
    command: ["php", "-r", "if (!is_file('vendor/autoload.php')) { fwrite(STDERR, \"php/vendor is missing. Run: cd php && composer install\\n\"); exit(1); }"],
    proves: "The PHP dependencies are installed, so the gates below can run.",
  },
  {
    id: "php:composer-validate",
    stage: "6. PHP validation",
    cwd: "php",
    command: ["composer", "validate", "--no-interaction", "--strict", "--no-check-publish"],
    proves: "composer.json is valid and in sync with composer.lock.",
  },
  {
    id: "php:lint",
    stage: "6. PHP validation",
    cwd: "php",
    command: ["php", "bin/lint.php"],
    proves: "php -l over every PHP source file, including files no test happens to autoload.",
  },
  {
    id: "php:static-analysis",
    stage: "6. PHP validation",
    cwd: "php",
    command: ["php", "bin/static-analysis.php"],
    proves:
      "PHPStan at level max over src/ and bin/, level 6 over tests/, plus PSR-12. Both levels are pinned in the committed configs, so the gate cannot drift by dependency upgrade.",
  },
  {
    id: "php:unit",
    stage: "6. PHP validation",
    cwd: "php",
    // `--testsuite eszter` explicitly, not by relying on the default: this gate
    // must not need a database, and the SQL suites are separate gates below.
    command: ["vendor/bin/phpunit", "--no-progress", "--testsuite", "eszter"],
    proves:
      "Configuration fail-fast including the production refusals of ESZ-027, contract-artifact digest verification, atomic JSON storage, the HTTP foundation against http-contract.json, ESZ-025/026 auth invariants, and Package 4.1/4.2 booking-domain rules without requiring SQL. Media, booking and notifications also have focused gates below, and ESZ-132's fail-closed operator password prompting plus ESZ-133's private-path/document-root topology refusals run in this suite as well. ESZ-134 adds the fail-closed login transition: an injected recordLogin failure after the session rotation, and a failing rotation revocation, are each driven through the real Kernel and must answer 500 with no Set-Cookie, no surviving authenticated session row and the pre-login anonymous session restored — same id, same CSRF token — so the very cookie that failed signs in on retry and the rotated id never authorises anything. ESZ-140 adds the retention policy, offline: the frozen placeholders and bounds are read from the booking-domain artifact and asserted to satisfy the same customer-validation rules live rows obey (with an RFC-2606 `.invalid` e-mail that can never be delivered to), and the retention CLI is exercised without a database — usage errors are exit 2, help is exit 0, and an operational failure is exit 1 with a message and no DSN or trace on stderr.",
  },
  {
    id: "php:parity-corpus",
    stage: "6. PHP validation",
    cwd: "php",
    command: ["vendor/bin/phpunit", "--no-progress", "--testsuite", "eszter", "--filter", "ParityCorpusTest|SemanticRuleCoverageTest|ContentValidatorTest"],
    proves:
      "The PHP validator replays contracts/generated/parity-corpus.json with identical accept/reject outcomes and identical issue paths, every rule declared in semantic-rules.json is implemented, and structural validation is driven by the generated JSON Schema rather than a second hand-written schema.",
  },
  {
    id: "php:http-contract",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "HttpContractConformanceTest|HttpFoundationTest|KernelBootTest",
    ],
    proves:
      "The full http-contract.json case list against the PHP HTTP layer: statuses, Allow headers, ETag/If-None-Match, 304 semantics, opaque storage failures, the over-limit body outcome and the bootstrap-failure envelope. Since ESZ-063/064/065 it also replays the availability administration and summary surface: every one of the four routes refuses an anonymous caller, the two mutations refuse a session without CSRF, the two reads need no token, and an inverted window, an overlapping weekly set, an empty open exception and a spring-forward boundary are each refused with the frozen envelope. Cases PHP is exempt from are declared in the artifact and asserted to be exactly one. ESZ-130 leaves the session read's normal 200 cases byte-identical while the anonymous bootstrap gains its contract-owned bucket and its bounded pre-creation sweep; the refusals it can now answer are the frozen 429 envelope plus Retry-After. ESZ-142 adds two create refusals to the corpus: a missing consent notice id and an id the immutable catalog does not contain are both 400 VALIDATION_FAILED before persistence, while the valid-creation case carries the current catalog notice id.",
  },

  {
    id: "php:public-page",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "PublicPageBootstrapTest",
    ],
    proves:
      "ESZ-021: the injector rewrites only the two bootstrap elements and leaves the rest of the export byte-identical, locates them by id rather than by a remembered opening tag, raises rather than emitting a half-injected page, keeps the payload valid JSON that no editorial string can break out of, and emits exactly the custom properties the contract declares — dropping any value that is not a validated hex colour.",
  },
  {
    id: "php:media",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "MediaUploadTest|MediaLibraryTest|MediaDeleteConcurrencyTest|MediaManagedReferenceGuardTest|MediaReferenceIntegrityTest",
    ],
    proves:
      "ESZ-036/037 against real image bytes: every allowed format is stored under a cryptographically random server-generated name with an extension derived from the verified type; a PHP script wearing JPEG magic bytes, an SVG, a GIF, a truncated JPEG and a polyglot whose two parsers disagree are all refused; a header declaring 1.6e10 pixels is refused before any decoder runs; the served derivative is the server's own re-encode, so EXIF and an appended payload are absent from it; an over-limit upload is 413 while the 64 kB JSON limit is unchanged on every other route; every refusal leaves no intake file, no original, no file under /media/ and no catalogue entry; and a delete is refused with 409 while either the authoritative draft or the published document still references the asset, removing nothing when it refuses. ESZ-100 adds deletion coherence: a delete stages both managed files ('.deleting-' names beside the originals), removes the staged bytes and only then commits the catalogue removal, so a 204 is never reported while bytes remain; a real permission failure on either managed directory or on the catalogue write answers 500 with the catalogue entry still in place, and the retry of the same delete converges to full deletion — including over the '.deleting-' residue of an interrupted attempt and over pre-missing derivative/original files; no transient file survives a successful delete. ESZ-100 also proves the media/content boundary with two real processes: a draft save that commits a reference while holding the boundary shared makes a concurrently started delete wait and then refuse (asset untouched), and a delete that owns the boundary exclusively through its whole check-to-commit critical section blocks a concurrently started save until the deletion is committed, in repeated runs with no deadlock. ESZ-147 adds managed-reference integrity on content writes: a save whose document carries a managed src absent from the catalogue is refused 400 VALIDATION_FAILED with draft bytes and revision byte-identical, while the exact catalogued path saves and HTTP(S), static/non-managed paths and null are unaffected; a catalogued id under the wrong extension or an uncatalogued managed path fails because membership is compared by exact public path; a deliberately stored dangling draft cannot be published — 500 STORAGE_FAILURE, opaque, with the previous published envelope byte-identical; the guard identifies managed paths through the frozen publicPathPattern and treats the catalogue as the sole authority (an entry whose bytes are missing still resolves, a stray file under a managed name does not), with real-process proofs that both save-vs-delete orders and both publish-vs-delete orders linearise on the shared boundary with no deadlock and no dangling published reference. ESZ-135 drives every standard PHP upload error code through the real route: INI_SIZE and FORM_SIZE stay 413 PAYLOAD_TOO_LARGE, NO_FILE and PARTIAL stay 400 VALIDATION_FAILED, while NO_TMP_DIR, CANT_WRITE, EXTENSION and any unrecognised non-zero code answer the opaque generic 500 INTERNAL_ERROR — never VALIDATION_FAILED — are logged at error level with a stable classification and the PHP upload error code, leak no error number, path or filename into the response, and leave zero managed artifacts; the silent post_max_size discard recovery remains a distinct warn-level 413 and is not conflated with host faults.",
  },
  {
    id: "php:routing",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "DocumentRootRoutingTest",
    ],
    proves:
      "ESZ-022/050: /api resolves before anything can shadow it, static assets are served directly, /admin deep links survive a refresh, /reservation resolves to its static export while unknown subpaths 404, `/` is never resolved as a static file, every declared rule is reachable, and the committed .htaccess is byte-identical to what the routing table renders using only directives legal in that context. Since ESZ-036 it also proves media/ serves managed assets and nothing else: the generated whitelist is executed against staging names, double extensions and case variants.",
  },
  {
    id: "php:booking",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "BookingDomainTest|AvailabilitySlotEngineTest",
    ],
    proves:
      "ESZ-040 through ESZ-045 without a database: stable service keys and state graph plus weekly windows, strict exception replacement, midnight-aligned grids, buffer/occupancy boundaries, bounded dynamic generation, spring-gap rejection and explicit fall-fold selection. ESZ-142 adds the consent-notice catalog to the same artifact-read contract: the PHP reader parses the immutable entries, the current id and the bounded-ASCII pattern, accepts exactly catalog ids, and a future-version fixture proves that moving the current pointer neither rejects nor remaps a historical id.",
  },
  {
    id: "php:security",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "RateLimitPolicyTest|RateLimitGuardTest|SecurityHeadersTest|StorageLimitReconciliationTest|MediaLibraryCapTest|PasswordPromptTest|ProvisionAdminCliTest|ConfigurationTest|PrivatePathIsolationTest",
    ],
    proves:
      "ESZ-084 without a database: the frozen rate-limit policy is refused rather than weakened when this implementation cannot honour it; a login charges the caller's address before the submitted identity and a throttled login is byte-identical whether or not the address names an account; a forwarding header never changes which bucket a request is charged to; the generated .htaccess sends CSP, Permissions-Policy and the baseline headers with `always` and names no external origin; the content read guard stays strictly above the request limit, which is what stops a save being accepted and then refused on the next read; and the media catalogue cap is enforced before the write, so an over-sized catalogue — the one cap a caller can reach — can no longer wedge the delete that would shrink it. ESZ-132 adds the fail-closed operator password prompt: `--password` is a usage error that leaks nothing, piped stdin performs no terminal command, terminal-state capture and echo-suppression failures abort before any secret read, an input exception still restores the terminal in `finally`, a failed restoration is itself an operational failure, and a confirmed success restores the exact captured state with the secret in neither output nor command. ESZ-133 adds document-root topology refusal: the five private runtime paths (content, tmp, locks, log, media originals) are refused when equal to or beneath `paths.public` — lexically with path-component awareness and, for existing directories, via resolved real paths that catch symlink aliases — while neighbouring prefixes, sibling layouts, the example/development topologies and the web-reachable `media/` exception stay valid; a real local router over a scratch document root proves that content draft/published, log, tmp and media-original canaries are never retrievable by direct or traversal URLs while public and managed-media files are served. ESZ-130 adds the one guarded GET to the same policy: the anonymous `GET /api/auth/session` read is charged to `auth.session.bootstrap.address` only when no live session was found, only through its own guard entry, and always before the route could create anything — a refused bootstrap is the frozen 429 `RATE_LIMITED` with `Retry-After` and sets no cookie, a live-session read is never charged, and the guard entry can never charge a non-session GET, a POST or any other path.",
  },
  {
    id: "php:backup",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "TarArchiveTest|BackupManifestTest",
    ],
    proves:
      "ESZ-083's archive format and integrity record, offline. Entries round-trip byte for byte through the hand-written ustar writer, GNU tar reads what it produces, writing is deterministic so two backups of an unchanged deployment agree, and a truncated archive, a corrupted header, an unsupported entry type and any path that would escape the destination are each refused. The manifest catches a missing entry, an altered one, an entry of the wrong length, an undeclared extra file, a rewritten digest and an unknown format version.",
  },
  {
    id: "security:filesystem",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "AtomicJsonFileTest|LoggerTest|MediaIngestFileModeTest|MediaLibraryFileModeTest",
    ],
    proves:
      "ESZ-103's sensitive-file permission boundary, on real temporary-filesystem modes and with negative injection, requiring no network, MySQL or browser: atomic JSON finals are published at 0640 and a write whose mode restriction fails — or was accepted but did not take effect — leaves the previous target byte-identical with no temp residue; upload intake is restricted to 0600 and a failed restriction catalogues nothing and converges; private originals are 0640 and served derivatives stay the intentional 0644, with each failed restriction unwinding every placed file and refusing the catalogue entry; log files are born and corrected to 0600 under a hostile process umask, which is restored on every path, and a log whose restriction cannot be established degrades to silence instead of crashing the caller or knowingly writing into a wider file; a pre-existing over-permissive target is corrected when possible and otherwise follows the component's fail/degrade contract.",
  },
  {
    id: "php:notifications",
    stage: "6. PHP validation",
    cwd: "php",
    command: [
      "vendor/bin/phpunit",
      "--no-progress",
      "--testsuite",
      "eszter",
      "--filter",
      "NotificationPolicyTest|NotificationCatchUpTest|BookingEmailTest",
    ],
    proves:
      "ESZ-070 through ESZ-074 without a database: the frozen queue policy, terminal states, retry bounds, safe diagnostics and catch-up rules; plus every deterministic booking e-mail template in text and escaped HTML, Paris-local date/time, SMTP 4xx/5xx retry classification, secret-free errors and multipart message construction through a no-network mailer double. ESZ-140 widens the frozen status graph to four terminal states — the retention sweep's `retired` is terminal and reachable from pending and processing only — and pins the reserved `customer_data_erased` code; the migration restatements in 0009 and 0011 are checked to carry every frozen status where SQL enforces them.",
  },

  // ── Stage 7 — SQL ─────────────────────────────────────────────────────────────
  //
  // ESZ-023 built the schema, the migrator and both suites, so these two gates are
  // no longer unconditionally NOT RUN. What they still need is somewhere to run:
  // a disposable MySQL database, named by ESZTER_TEST_DB_DSN. Without it they
  // report NOT RUN naming the missing prerequisite rather than the missing
  // subject, which is a different — and much smaller — gap than the one that was
  // recorded here before.
  //
  // MySQL specifically, not SQLite. The engine is the thing under test: `utf8mb4`
  // collations, `ON DUPLICATE KEY UPDATE`, `GET_LOCK`, foreign keys, and above all
  // the implicit commit around DDL that makes a migration non-atomic and forces
  // every migration file to be idempotent. A green SQLite run would prove none of
  // it and would make the idempotence rule look like superstition.
  {
    id: "sql:migrations",
    stage: "7. SQL",
    cwd: "php",
    command: ["vendor/bin/phpunit", "--no-progress", "--testsuite", "sql-migrations"],
    unavailable: sqlDatabaseUnavailable,
    proves:
      "Every migration applies to an empty database in order, is idempotent on re-run, and leaves schema_migrations consistent. It also proves the booking tables, constraints, foreign keys, indexes, singleton serialization row and durable history on MySQL, and proves there is no persisted slot table. ESZ-070 adds notification_jobs: its enum, identity, error-code, lease, sent-instant and attempt-ceiling CHECKs are each proved to refuse a bad row, its idempotency key is proved unique, and deleting a booking a notification refers to is proved to be refused rather than cascading. ESZ-140 adds migration 0011: the guarded ALTERs re-run cleanly after a partial application, the schema restates the retention artifact (the erasure column and CHECK, and a status CHECK that admits `retired` and no non-frozen status), the database itself refuses to repopulate an erased booking, and a `retired` job row satisfies every terminal constraint. ESZ-130 adds migration 0013: the guarded ADD KEY on `admin_sessions.absolute_expires_at` completes cleanly when re-run after a partial application, and EXPLAIN proves that both session-deadline indexes (the 0002 idle one and the 0013 absolute one) answer the bounded GC deletes as index-range reads with no table scan and no filesort. ESZ-142 adds migration 0014: the guarded ADD COLUMN stores the bounded-ASCII consent_notice_id (ascii_bin) beside consent_at_utc with a CHECK restating the catalog id pattern and NULL legal only as the pre-catalog marker; applying it over a database that already holds bookings preserves them byte for byte (NULL notice id, consent instant untouched) while new inserts carry the id, and over-long or non-lowercase ids are refused by the schema. Runs only against a disposable database whose name ends in `_test`.",
  },
  {
    id: "sql:integration",
    stage: "7. SQL",
    cwd: "php",
    command: ["vendor/bin/phpunit", "--no-progress", "--testsuite", "sql-integration"],
    unavailable: sqlDatabaseUnavailable,
    proves:
      "Admin auth plus the booking backend against real MySQL: availability, DST, buffers, atomic lifecycle/history, HTTP auth/CSRF and Package 6.2 availability administration. ESZ-087 drives two independent PHP processes through the production Kernel and POST /api/bookings for the same valid slot, proving exactly one 201 confirmation, one 409 SLOT_UNAVAILABLE, one booking/history occurrence and one confirmation/reminder job pair. ESZ-146 proves the one authoritative serialization boundary: deterministic two-connection/two-process races parked on real MySQL row locks, with no timing sleep as the correctness argument, cover booking create and move against each bookability mutation (a closed date exception, a weekly replacement removing the slot, a service disable and a duration change invalidating the requested slot) in both linearization orders — mutation-first, where the create/move waits behind the mutation, re-reads the new state and cannot confirm an invalid slot, and booking-first, where the create/move commits first and the mutation follows without deadlock — asserting final DB state and not only exit codes; repeated service provisioning stays repeat-safe and a stale expectedRevision remains a deterministic revision conflict that writes nothing (ESZ-137). ESZ-074 adds atomic lifecycle e-mail jobs: exact T−24h reminders, move supersession and rescheduling, cancellation retirement, terminal catch-up skips, stable identities, duplicate prevention and rollback safety across booking, history and notification tables. ESZ-134 proves login fail-closed under the full production wiring (a kernel booted over this database, no seams): a required rehash commits atomically with the rotation and the login record — verified across admin_sessions and admin_accounts after success — while a forced post-rotation failure, a real trigger SIGNAL raised on the recordLogin write and separately on the rehash write, answers 500 with no Set-Cookie and rolls the authenticated session row, last_login_at and the hash change back together, leaving exactly the pre-login anonymous row live under its original id. ESZ-140 proves customer-data retention against real MySQL: confirmed and cancelled bookings on both sides of the 90-day cutoff plus future rows untouched; the target PII/free-text erased while appointment evidence, history and terminal notification evidence survive; pending and processing jobs retired with the frozen code and their leases cleared; fact resolution refusing an erased booking; a second retention run changing zero rows; the shipped retention CLI erasing and retiring in one run and changing nothing in a second, printing no seeded PII or reference anywhere; admin contact/lifecycle updates unable to reintroduce PII into an erased booking; and history details_json shown to hold field names and instants, never customer values, before and after erasure. ESZ-130 bounds the anonymous-session bootstrap end to end through the same production wiring: repeated no-cookie reads of GET /api/auth/session admit exactly the frozen burst (10) and then answer 429 RATE_LIMITED with Retry-After and no Set-Cookie, adding zero admin_sessions rows; invented, malformed and expired cookies are each a fresh charge and the supplied id is never adopted; a retained cookie reuses and touches one anonymous session and spends none of the new-bootstrap allowance while a live-session read keeps answering 200 even when the same address is over budget; the bounded two-pass sweep runs through the real bootstrap wiring, drains 900 idle- and absolute-expired rows in 400/400/100 batches with every live row untouched and converges to zero changes, and a real MySQL SIGNAL on the sweep DELETE answers the opaque 500 with no row and no cookie, the same read succeeding once the cause is removed; the anonymous cookie and CSRF an admitted bootstrap issues still log in while cross-paired cookie and token are refused; and neither the limiter rows nor the debug log expose the address, any session id or any CSRF token. ESZ-139 proves the per-booking optimistic-concurrency token on real MySQL: admin update/move/cancel require expectedUpdatedAt and compare it byte-for-byte under the authoritative row lock before any write, history append or notification scheduling — a stale contact update cannot overwrite a newer one, a stale move or cancel writes no history and schedules no job, move-then-stale-cancel and cancel-then-stale-move are both refused, two real concurrent processes replaying one token yield exactly one success and one BookingRevisionConflictException with a single history event, the same frozen millisecond or a backward application clock still mints a strictly newer canonical updatedAt from one derived instant (updated_at, state_changed_at and cancelled_at_utc all agree), a fresh re-read token unblocks the next mutation, and the HTTP surface answers 409 REVISION_CONFLICT with the closed envelope and no internal state leaked while a token-less mutation is a schema 400. ESZ-142 proves against real MySQL that a public creation stores the request's consent notice id beside the consent instant, that a missing or unknown id (or any attempt to send notice text instead) is refused before insertion with zero rows or history, that admin contact updates never rewrite the stored consent facts, and that retention erasure preserves consent_at_utc and consent_notice_id — for catalog-era and legacy rows alike — while erasing the customer PII. ESZ-145 bounds admin booking SQL and history payloads on the same MySQL: with a statement recorder attached to the suite connection, one range page costs exactly one query whether the window holds 0 or 200 bookings and performs zero booking_history reads, a 1000-booking walk costs exactly five queries (one per page, O(pages) never O(bookings)) and reproduces every reference in order, a booking with 2501 history events serves at most one fixed 50-event reference page with correct hasMore and a strictly advancing eventId cursor, paging that trail reaches all 2501 events without duplicate or gap in 51 pages (51 booking lookups + 51 LIMIT-51 probes) and terminates with hasMore cleared, a contact-update mutation of a booking with 2000 history rows executes exactly four statements of which the single booking_history one is the event INSERT — the trail is never SELECTed — and the real range/reference/mutation HTTP responses validate cleanly against the generated admin-bookings, admin-booking-reference and admin-booking response schemas. ESZ-109 proves the AUD-14 label authority through the real provisioning CLI against this database: provisioning stores the title of the matching item of the validated published SiteContent document (written through the real content-storage/contract-validation path), a published title change followed by re-provisioning refreshes the stored mirror, `--label` is refused (exit 2, zero rows), an unknown key is refused (exit 2, zero rows), and missing or invalid published content refuses (exit 1) with an existing row byte-untouched.",
  },
  {
    id: "sql:rate-limits",
    stage: "7. SQL",
    cwd: "php",
    command: ["vendor/bin/phpunit", "--no-progress", "--testsuite", "sql-rate-limits"],
    unavailable: sqlDatabaseUnavailable,
    proves:
      "ESZ-084 against real MySQL, because every guarantee it makes is a property of the store rather than of the algorithm. Allowance is spent across separate charges and survives them, which is the whole point on a runtime where each request is its own process; it is restored exactly one emission interval later and not a millisecond earlier; a refused charge writes nothing, so hammering a full bucket cannot lengthen the penalty; two subjects and two scopes never share a row; an idle bucket recovers its whole burst but accumulates no credit beyond it; no address or e-mail is stored in clear; a row is never sweepable while it is still refusing;  and two independent operating-system processes racing the last allowance admit exactly one. ESZ-130 adds the anonymous-session bootstrap bucket to the same store: its frozen rule (30 per hour, burst 10, one 120-second emission interval) admits exactly ten charges at one instant, refuses the eleventh, restores exactly one unit one emission interval later, and two independent processes racing its last allowance still admit exactly one.",
  },
  {
    id: "sql:backup-restore",
    stage: "7. SQL",
    cwd: "php",
    command: ["vendor/bin/phpunit", "--no-progress", "--testsuite", "sql-backup-restore"],
    unavailable: sqlDatabaseUnavailable,
    proves:
      "ESZ-083's clean restore proof plus ESZ-097's coherence proof: all dumped tables and row counts come from one explicit MySQL consistent snapshot, and a backup paused after SQL export excludes a correlated SQL + content mutation in a second PHP process so the archive is wholly pre-mutation and the live state wholly post-mutation. The realistic clean restore, byte integrity, exclusions, size/security rules and restore refusals remain covered. ESZ-140 proves restore-time retention reconciliation: an archive carrying PII already expired at restore time comes back anonymized with its pending job retired and its live neighbour untouched — before the restore reports success — and an injected failure before or after the reconciliation rolls rows, erasures and files back to the complete old state through the ESZ-098 compensation path, so retention-reconciliation failure can never produce restore success.",
  },
  {
    id: "sql:notifications",
    stage: "7. SQL",
    cwd: "php",
    command: ["vendor/bin/phpunit", "--no-progress", "--testsuite", "sql-notifications"],
    unavailable: sqlDatabaseUnavailable,
    proves:
      "ESZ-070/071/072 against real MySQL, because almost none of it is true on any other engine. A repeated enqueue resolves to the same row and does not reschedule it, while a key reused for a different booking is refused rather than silently ignored. A claim takes a durable lease, charges one attempt and is invisible to a second claim; a job that is not yet due, or whose channel has no transport, is never claimed at all. Delivery succeeds exactly once and `sent` is terminal. Transient failures retry on the frozen 60/120/240/480-second backoff and become terminal on the fifth attempt; a permanent refusal is terminal on the first; a transport that throws anything else is classified as transient and its message never reaches storage or the log. An abandoned lease is recovered a second after it expires and not a second before, without forgiving the attempt it charged, so a job that kills every runner exhausts its budget instead of looping. A runner whose lease expired mid-delivery cannot record a delivery it no longer owns. One run claims at most its batch, so a backlog drains across ticks. A stale reminder is retired before it can be claimed and again after, and never delivered; a non-time-sensitive job is never retired for being old; a disabled channel produces terminal skips so a later re-enable finds nothing pending to burst. No customer name, address, phone, note or database credential appears in any log line, and every key on every line is on the frozen allowlist. Finally, two independent operating-system processes blocked on the same row prove that exactly one claims, exactly one delivers, and the job records exactly one attempt.",
  },

  // ── Stage 8 — Local HTTP smoke ────────────────────────────────────────────────
  {
    id: "smoke:local-php",
    stage: "8. HTTP smoke",
    cwd: ".",
    command: ["node", "scripts/smoke-local-php.mjs"],
    proves:
      "The documented PHP development command starts a real built-in server; / renders the injected Eszter export, a generated frontend asset resolves, /api/health crosses the production front controller, and unknown public/API routes keep their HTML/JSON 404 contracts without a PHP routing or bootstrap fatal.",
  },
  {
    id: "smoke:deployed-http",
    stage: "8. HTTP smoke",
    status: NOT_RUN,
    reason:
      "No deployed PHP origin to target. Local built-in-server routing is proved separately; what remains unproven here is Apache applying .htaccess plus deployment-owned TLS and headers.",
    proves:
      "Against a deployed origin: GET /api/content with ETag revalidation, 405 on a wrong method, HTTPS redirect and security headers, /admin deep links and /reservation under the real Apache configuration.",
  },

  // ── Stage 9 — Browser scenarios ───────────────────────────────────────────────
  {
    id: "browser:admin-preview-csp",
    stage: "9. Browser scenarios",
    cwd: ".",
    command: ["node", "scripts/browser-admin-preview-csp.mjs"],
    proves:
      "ESZ-095 in a real browser against Apache applying the committed generated .htaccess: the response carries the restrictive CSP, the real same-origin /admin/preview export loads inside an iframe without a frame-src violation, and an external iframe is blocked with a frame-src violation. This focused proof does not claim the broader authenticated browser:admin workflow.",
  },
  {
    id: "browser:media-pipeline",
    stage: "9. Browser scenarios",
    cwd: ".",
    command: ["node", "scripts/browser-media-pipeline.mjs"],
    proves:
      "ESZ-096 in a real browser and isolated full stack: a real image is uploaded and selected through the admin media library, rendered and decoded in preview across Hero, Services, Gallery and About, saved and published through the server workflow, then rendered and decoded from the same managed path on the public page. Null and broken-source fallbacks are exercised before publication.",
  },
  {
    id: "browser:admin-booking-contact",
    stage: "9. Browser scenarios",
    cwd: ".",
    command: ["node", "scripts/browser-admin-booking-contact.mjs"],
    proves:
      "ESZ-099 in a real browser and isolated full stack: a public booking is created from real same-day availability, its contact details are edited through the authenticated admin calendar and persist across reload, client-side invalid email keeps the editor open, and the admin API confirms the rejected edit did not alter server state.",
  },
  {
    id: "browser:public",
    stage: "9. Browser scenarios",
    cwd: ".",
    command: ["node", "scripts/browser-public.mjs"],
    proves:
      "ESZ-104 in a real browser under Apache applying the committed generated .htaccess: the public page renders the published content — hero and gallery media decode from their published sources, and the nav, gallery, contact and footer links resolve exactly as /api/content declares them; navigation clicks and direct deep links land below the fixed navbar; the layout holds at phone/tablet/desktop widths without horizontal overflow. ESZ-104 image policy: a same-origin managed image loads and decodes with no CSP violation, a cross-origin HTTPS image from a local TLS fixture loads and decodes under scheme-wide `https:`, an http: media source is refused as contract-invalid through the real draft-save envelope (400 VALIDATION_FAILED, draft unchanged) before any publication, and an intentionally injected http: <img> negative control is CSP-blocked while the same fixture origin demonstrably serves images outside the page. All fixtures are local; nothing leaves 127.0.0.1.",
  },
  {
    id: "browser:admin-auth",
    stage: "9. Browser scenarios",
    cwd: ".",
    command: ["node", "scripts/browser-admin-auth.mjs"],
    proves:
      "ESZ-101 in a real browser against an isolated full stack (real PHP, disposable MySQL, headless Chrome): an operator password rotation signs an authenticated browser out server-side — the editor reloads to the signed-out screen, the old credential is refused and the new one signs in; a logout whose server-side record deletion fails (real MySQL trigger) stays on the authenticated admin surface with a retryable error and never claims a signed-out state, while the session keeps authorising until the retry succeeds once the cause is removed; and a clean logout lands on /admin/login with the server row gone and the pre-logout cookie no longer authorising anything.",
  },
  {
    id: "browser:admin",
    stage: "9. Browser scenarios",
    status: NOT_RUN,
    reason:
      "The focused ESZ-095, ESZ-096 and ESZ-101 runners cover preview CSP, the media pipeline and the authenticated sign-out workflow only. No deployed origin or project-owned runner covers this full authenticated editing workflow.",
    proves:
      "Admin: unauthenticated deep link redirects to login, login succeeds and rejects bad credentials, an edit saves to the server draft, publish updates the public site, and logout invalidates the session server-side.",
  },
  {
    id: "browser:booking",
    stage: "9. Browser scenarios",
    status: NOT_RUN,
    reason: "No deployed origin or project-owned runner covers this broader booking scenario; Packages 5.1 and 7.2 are covered offline by frontend/API/routing, notification and real-MySQL producer tests.",
    proves:
      "Booking: a request submits, validates, persists, is visible in admin, and enqueues its notifications; invalid input is rejected without data loss.",
  },

  // ── Stage 10 — Security and configuration (not available) ─────────────────────
  {
    id: "security:config",
    stage: "10. Security and configuration",
    status: NOT_RUN,
    reason: "No deployed host or PHP configuration to inspect.",
    proves:
      "No secret is web-reachable, private paths return 404/403, directory indexing is off, PHP execution is disabled under media/, security headers are present, and config file permissions are 0600. Dependency advisories are no longer part of this live-only gate; security:dependencies executes in Stage 1.",
  },
];

/**
 * The prerequisite both SQL gates share.
 *
 * Returns a reason when the gate cannot run, null when it can. Deliberately not a
 * connection attempt: a gate runner that talked to a database would need its own
 * error handling, its own timeout and its own idea of what "reachable" means, and
 * would then disagree with the suite it is about to start. Presence of the
 * variable is the prerequisite; whether the server behind it works is the suite's
 * problem, and the suite reports it as a FAIL rather than as an absence.
 */
function sqlDatabaseUnavailable() {
  if (process.env.ESZTER_TEST_DB_DSN) return null;

  return (
    "No test database is configured. Set ESZTER_TEST_DB_DSN (plus ESZTER_TEST_DB_USERNAME " +
    "and ESZTER_TEST_DB_PASSWORD) to a disposable MySQL database whose name ends in `_test`. " +
    "The schema, the migrations and both suites exist; only the server is missing."
  );
}

function parseArgs(argv) {
  return {
    list: argv.includes("--list"),
    json: argv.includes("--json"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function runGate(gate) {
  const started = Date.now();
  const result = spawnSync(gate.command[0], gate.command.slice(1), {
    cwd: resolve(repoRoot, gate.cwd),
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, CI: "1", NO_COLOR: "1", TZ: "UTC" },
  });

  const durationMs = Date.now() - started;

  if (result.error) {
    return { status: FAIL, durationMs, detail: result.error.message };
  }
  if (result.status === 0) {
    return { status: PASS, durationMs };
  }
  return {
    status: FAIL,
    durationMs,
    detail: `exit ${result.status}`,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(
      [
        "Usage: node scripts/validate.mjs [--list] [--json]",
        "",
        "  --list   print the declared gates and exit without running anything",
        "  --json   emit a machine-readable report on stdout",
        "",
        "Exit codes: 0 = no gate failed, 1 = at least one gate failed, 2 = runner error.",
        "NOT RUN gates never count as passes.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (args.list) {
    for (const gate of gates) {
      const state =
        gate.status === NOT_RUN || gate.unavailable?.() ? "not run" : "executable";
      process.stdout.write(`${gate.stage.padEnd(34)} ${gate.id.padEnd(30)} ${state}\n`);
    }
    return 0;
  }

  const report = [];
  let currentStage = null;
  let failed = false;

  for (const gate of gates) {
    if (gate.stage !== currentStage) {
      currentStage = gate.stage;
      if (!args.json) process.stdout.write(`\n── ${currentStage} ${"─".repeat(Math.max(0, 58 - currentStage.length))}\n`);
    }

    // A gate is NOT RUN either because its subject does not exist (`status`) or
    // because a prerequisite for running it is absent (`unavailable`). Both are
    // reported identically, and neither is a pass.
    const unavailableReason = gate.status === NOT_RUN ? gate.reason : gate.unavailable?.();

    if (unavailableReason) {
      report.push({ id: gate.id, stage: gate.stage, status: NOT_RUN, reason: unavailableReason });
      if (!args.json) {
        process.stdout.write(`  ${NOT_RUN.padEnd(8)} ${gate.id.padEnd(30)} ${unavailableReason}\n`);
      }
      continue;
    }

    const outcome = runGate(gate);
    report.push({ id: gate.id, stage: gate.stage, ...outcome });

    if (!args.json) {
      const seconds = (outcome.durationMs / 1000).toFixed(1);
      process.stdout.write(`  ${outcome.status.padEnd(8)} ${gate.id.padEnd(30)} ${seconds}s\n`);
      if (outcome.status === FAIL) {
        process.stdout.write(`           ${outcome.detail}\n`);
        if (outcome.output) {
          process.stdout.write(
            outcome.output
              .split("\n")
              .slice(-25)
              .map((line) => `           │ ${line}`)
              .join("\n") + "\n",
          );
        }
      }
    }

    if (outcome.status === FAIL) failed = true;
  }

  const passed = report.filter((entry) => entry.status === PASS).length;
  const failures = report.filter((entry) => entry.status === FAIL);
  const notRun = report.filter((entry) => entry.status === NOT_RUN).length;

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ passed, failed: failures.length, notRun, gates: report }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(`\n${"─".repeat(62)}\n`);
    process.stdout.write(`  ${passed} passed   ${failures.length} failed   ${notRun} not run\n`);
    if (failures.length > 0) {
      process.stdout.write(`\n  Failed: ${failures.map((entry) => entry.id).join(", ")}\n`);
    }
    if (notRun > 0) {
      process.stdout.write(
        `\n  ${notRun} gate(s) could not execute and are NOT passes.\n` +
          "  Each NOT RUN line above names its missing prerequisite.\n",
      );
    }
    process.stdout.write("  Policy: docs/v1-quality-gates.md\n");
  }

  return failed ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`validate: runner error: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
