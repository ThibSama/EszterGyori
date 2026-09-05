#!/usr/bin/env node
/**
 * ESZ-129 — the production-acceptance CLI.
 *
 * The CLI owns the authorization boundary and nothing else:
 *
 *   - the target must be an explicit HTTPS origin (no credentials, query,
 *     fragment or path);
 *   - state-changing and cleanup/resume modes require the exact live
 *     confirmation phrase;
 *   - every secret is read from the environment, never from arguments;
 *   - read-only mode (no phrase) only runs the project readiness probe and
 *     never mutates anything.
 *
 * The state-changing machinery — resource tracking, `expectedUpdatedAt`
 * mutations, best-effort compensation, the unresolved-cleanup debt gate and
 * the cleanup/resume mode — lives in `scripts/production-acceptance-core.mjs`
 * and is driven by the tests directly against the disposable local
 * full-stack fixture.
 *
 * Modes:
 *   read-only   ESZTER_ACCEPTANCE_TARGET_URL=https://… npm run acceptance:production
 *   authorized  … + the four secrets + --live-confirmation=<exact phrase>
 *   cleanup     same authorization envelope as authorized, plus --cleanup:
 *               resolves the origin's debt or reports there is none.
 */

import { pathToFileURL } from "node:url";
import { probeReadiness, READINESS_COMPONENTS } from "./readiness.mjs";
import {
  runAuthorizedAcceptance,
  runCleanupAcceptance,
  UsageError,
} from "./production-acceptance-core.mjs";
import { debtDirFor } from "./acceptance-debt.mjs";

const LIVE_CONFIRMATION = "I_AUTHORIZE_ESZTER_LIVE_MUTATIONS";

function usage() {
  return `Usage:
  ESZTER_ACCEPTANCE_TARGET_URL=https://… npm run acceptance:production
  ESZTER_ACCEPTANCE_TARGET_URL=https://… ESZTER_ACCEPTANCE_ADMIN_EMAIL=… \\
    ESZTER_ACCEPTANCE_ADMIN_PASSWORD=… ESZTER_ACCEPTANCE_CUSTOMER_EMAIL=… \\
    npm run acceptance:production -- --live-confirmation=${LIVE_CONFIRMATION}
  npm run acceptance:production -- --cleanup --live-confirmation=${LIVE_CONFIRMATION}

Without the exact confirmation value, only read-only checks run. Secrets are read
from the environment so they do not enter shell history or process arguments.

--cleanup  resolves an unresolved cleanup debt for the target origin (it loads
           the debt, authenticates only when a recorded step needs the admin
           surface, retries the safe cleanup with authoritative re-queries and
           deletes the debt record only after every recorded resource is
           verified clean). There is no --force and no other escape hatch:
           a state-changing run refuses to create any new mutation while
           unresolved debt exists.
`;
}

/** Resolves the target URL and the authorization verdict. */
export function parseTarget(env) {
  const targetValue = env.ESZTER_ACCEPTANCE_TARGET_URL;
  if (!targetValue) throw new Error("ESZTER_ACCEPTANCE_TARGET_URL is required.");
  const target = new URL(targetValue);
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) {
    throw new Error("The target must be an explicit HTTPS origin with no credentials, query or fragment.");
  }
  if (target.pathname !== "/") throw new Error("The target must be an origin URL ending at `/`.");
  return target;
}

function parseArguments(argv) {
  const args = new Map();
  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    if (args.has(match[1])) throw new Error(`Duplicate argument: --${match[1]}`);
    args.set(match[1], match[2] ?? true);
  }
  return args;
}

/**
 * Read-only mode = the project readiness probe (ESZ-127/AUD-22).
 *
 * Health alone is liveness, so it is not enough: readiness must also prove the
 * exported public page, the published `/api/content` envelope and that
 * `/api/booking/services` reaches the real booking/MySQL surface with at least
 * one active bookable service. Those are exactly the checks
 * `scripts/readiness.mjs` runs — reused here rather than duplicated, so the
 * deployed-origin answer and the local one come from the same code. The probe
 * is read-only by construction: no session, no upload, no booking, no cron,
 * no SMTP contact.
 */
export async function readOnlyChecks(target) {
  const verdict = await probeReadiness(target.origin);
  for (const name of READINESS_COMPONENTS) {
    const component = verdict.components[name];
    const detail = component.passed ? "PASS" : `FAIL — ${component.reason}`;
    process.stdout.write(`READINESS ${name}: ${detail}\n`);
  }
  if (!verdict.ready) {
    const summary = verdict.failures
      .map((name) => `${name}: ${verdict.components[name].reason}`)
      .join("; ");
    throw new Error(`readiness probe FAILED — ${summary}`);
  }
}

/**
 * CLI entry point. `argv` and `env` are injectable so tests can exercise the
 * authorization boundary in-process; the exit code is returned, never set.
 *
 * @returns {Promise<number>} 0 PASS, 1 FAIL, 2 usage
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`FAIL ${error.message}\n`);
    return 2;
  }

  if (args.has("help")) {
    process.stdout.write(usage());
    return 0;
  }

  let target;
  try {
    target = parseTarget(env);
  } catch (error) {
    process.stderr.write(`FAIL ${error.message}\n`);
    return 1;
  }

  const confirmed = args.get("live-confirmation") === LIVE_CONFIRMATION;
  const cleanupMode = args.has("cleanup");
  const modeLabel = cleanupMode ? "CLEANUP/RESUME" : confirmed ? "AUTHORIZED STATE-CHANGING" : "READ-ONLY";
  process.stdout.write(`Target: ${target.origin}\nMode: ${modeLabel}\n`);

  try {
    if (cleanupMode) {
      if (!confirmed) {
        process.stderr.write(
          `FAIL state-changing cleanup requires the exact --live-confirmation=${LIVE_CONFIRMATION}.\n`,
        );
        return 1;
      }
      const outcome = await runCleanupAcceptance({
        origin: target.origin,
        adminEmail: env.ESZTER_ACCEPTANCE_ADMIN_EMAIL,
        adminPassword: env.ESZTER_ACCEPTANCE_ADMIN_PASSWORD,
        debtDir: debtDirFor(env),
      });
      return outcome.ok ? 0 : 1;
    }

    if (!confirmed) {
      await readOnlyChecks(target);
      process.stdout.write(
        "Readiness PASS: liveness, public page, published content and booking services all answered. "
        + `State-changing checks NOT RUN; exact --live-confirmation=${LIVE_CONFIRMATION} was not supplied.\n`,
      );
      return 0;
    }

    const result = await runAuthorizedAcceptance({
      origin: target.origin,
      adminEmail: env.ESZTER_ACCEPTANCE_ADMIN_EMAIL,
      adminPassword: env.ESZTER_ACCEPTANCE_ADMIN_PASSWORD,
      customerEmail: env.ESZTER_ACCEPTANCE_CUSTOMER_EMAIL,
      debtDir: debtDirFor(env),
    });
    process.stdout.write("LIVE-PENDING: run/observe the authorized SMTP cron and verify the confirmation and cancellation messages in the approved mailbox, including the booking reference.\n");
    process.stdout.write("LIVE-PENDING: complete the browser viewport/interaction worksheet in docs/production-acceptance.md.\n");
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`FAIL ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`FAIL ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`acceptance runner error: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    },
  );
}
