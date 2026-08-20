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
      "The parity corpus replays green, every declared semantic rule has a rejecting case, and the refinement census matches. This is the suite a PHP implementation must also pass.",
  },

  // ── Stage 4 — Frontend behaviour ──────────────────────────────────────────────
  {
    id: "front:test",
    stage: "4. Frontend behaviour",
    cwd: "front",
    command: ["npm", "run", "-s", "test"],
    proves:
      "Content encoding integrity, appearance/contrast rules, admin/public isolation, local-draft semantics and responsive behaviour.",
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
      "ESZ-020: out/ is deployable without Node. No dynamic route, middleware, rewrite, route handler or server-only dependency survived; every route reached out/ as a file; and out/index.html carries a parseable bootstrap payload and a colours-only appearance block for ESZ-021's PHP injection to rewrite.",
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
      "Configuration fail-fast including the production refusals of ESZ-027, contract-artifact digest verification, atomic JSON storage (temp-write, fsync, rename, size cap, locking, idempotent seeding, no silent replacement of invalid files), the HTTP foundation against http-contract.json, and the ESZ-025/026 auth invariants against in-memory doubles. Media has its own gate below; the notification queue is not covered because it does not exist yet.",
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
      "The full http-contract.json case list against the PHP HTTP layer: statuses, Allow headers, ETag/If-None-Match, 304 semantics, opaque storage failures, the over-limit body outcome and the bootstrap-failure envelope. Cases PHP is exempt from are declared in the artifact and asserted to be exactly one.",
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
      "MediaUploadTest|MediaLibraryTest",
    ],
    proves:
      "ESZ-036/037 against real image bytes: every allowed format is stored under a cryptographically random server-generated name with an extension derived from the verified type; a PHP script wearing JPEG magic bytes, an SVG, a GIF, a truncated JPEG and a polyglot whose two parsers disagree are all refused; a header declaring 1.6e10 pixels is refused before any decoder runs; the served derivative is the server's own re-encode, so EXIF and an appended payload are absent from it; an over-limit upload is 413 while the 64 kB JSON limit is unchanged on every other route; every refusal leaves no intake file, no original, no file under /media/ and no catalogue entry; and a delete is refused with 409 while either the authoritative draft or the published document still references the asset, removing nothing when it refuses.",
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
      "ESZ-022: /api resolves before anything can shadow it, static assets are served directly, /admin deep links survive a refresh, /reservation is reserved and ships no booking UI, `/` is never resolved as a static file, every declared rule is reachable, and the committed .htaccess is byte-identical to what the routing table renders using only directives legal in that context. Since ESZ-036 it also proves media/ serves managed assets and nothing else: the generated whitelist is executed against staging names, double extensions and case variants.",
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
      "Every migration applies to an empty database in order, is idempotent on re-run, and leaves schema_migrations consistent. A half-applied migration completes on the next run; editing an applied one, or finding a schema ahead of the code, is refused; concurrent runs serialise on an advisory lock. Runs against a disposable database, never a shared one — the suite refuses any database whose name does not end in `_test`.",
  },
  {
    id: "sql:integration",
    stage: "7. SQL",
    cwd: "php",
    command: ["vendor/bin/phpunit", "--no-progress", "--testsuite", "sql-integration"],
    unavailable: sqlDatabaseUnavailable,
    proves:
      "The admin account and session repositories against a real MySQL instance seeded by the real migrations, each test isolated in a rolled-back transaction: repeat-safe provisioning, identity normalisation and the byte-exact e-mail index, password hashing, both session deadlines with the absolute one un-extendable, targeted invalidation, and the whole login/CSRF/logout flow driven through the front controller against MySQL. Booking, settings and notifications are not covered because they do not exist yet.",
  },

  // ── Stage 8 — HTTP smoke (not available) ──────────────────────────────────────
  {
    id: "smoke:http",
    stage: "8. HTTP smoke",
    status: NOT_RUN,
    reason:
      "No deployed PHP origin to target. The routing rules and the injection are covered offline by `php:routing` and `php:public-page`; what is still unproven is Apache actually applying the generated .htaccess.",
    proves:
      "Against a running origin: GET /api/health, GET /api/content with ETag revalidation, a JSON 404 on an unknown /api path, 405 on a wrong method, HTTPS redirect and security headers, that / serves fully populated HTML with a published-<revision> ETag, and that /admin deep links and /reservation resolve as the routing table says they do.",
  },

  // ── Stage 9 — Browser scenarios (not available) ───────────────────────────────
  {
    id: "browser:public",
    stage: "9. Browser scenarios",
    status: NOT_RUN,
    reason: "No browser runner is configured and no origin is deployed.",
    proves:
      "Public site: page renders published content, navigation deep links land below the fixed navbar, gallery and Instagram links resolve, layout holds at phone/tablet/desktop widths.",
  },
  {
    id: "browser:admin",
    stage: "9. Browser scenarios",
    status: NOT_RUN,
    reason: "No browser runner is configured and no origin is deployed.",
    proves:
      "Admin: unauthenticated deep link redirects to login, login succeeds and rejects bad credentials, an edit saves to the server draft, publish updates the public site, and logout invalidates the session server-side.",
  },
  {
    id: "browser:booking",
    stage: "9. Browser scenarios",
    status: NOT_RUN,
    reason: "No booking flow exists yet.",
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
      "No secret is web-reachable, private paths return 404/403, directory indexing is off, PHP execution is disabled under media/, security headers are present, config file permissions are 0600, and no dependency has a known critical advisory.",
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
    process.stdout.write(
      `\n  ${notRun} gate(s) could not execute and are NOT passes.\n` +
        "  The SQL gates need ESZTER_TEST_DB_DSN to name a disposable MySQL database;\n" +
        "  the rest become executable as a deployed origin and a browser runner arrive.\n" +
        "  Policy: docs/v1-quality-gates.md\n",
    );
  }

  return failed ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`validate: runner error: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
