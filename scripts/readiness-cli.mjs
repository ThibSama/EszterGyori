#!/usr/bin/env node

/**
 * CLI wrapper for the project-owned readiness probe (ESZ-127/AUD-22).
 *
 * Runs exactly the same checks as `scripts/readiness.mjs` against one supplied
 * origin and reports one deterministic line per component plus a verdict:
 *
 *   origin: http://127.0.0.1:8091
 *   health: PASS
 *   page: PASS
 *   content: PASS
 *   booking: FAIL — GET /api/booking/services answered HTTP 500
 *   readiness: FAIL
 *
 * Exit codes: 0 = readiness PASS, 1 = readiness FAIL (or a probe error),
 * 2 = usage error. Output is read-only: no session, upload, booking, cron or
 * SMTP contact is ever made. See the module docblock for the exact meaning of
 * each component and why health alone is liveness, not readiness.
 */

import { probeReadiness, READINESS_COMPONENTS } from "./readiness.mjs";

function usage() {
  process.stdout.write(`Usage:
  node scripts/readiness-cli.mjs --origin=http://127.0.0.1:8080

Runs the project readiness probe against one http(s) origin: /api/health
(liveness under its contract), the exported public page, the published
/api/content envelope, and /api/booking/services reaching at least one active
bookable service. Read-only; exit 0 on PASS, 1 on FAIL, 2 on usage error.
`);
}

const args = new Map(process.argv.slice(2).map((argument) => {
  const match = argument.match(/^--([^=]+)(?:=(.*))?$/);
  if (!match) throw new Error(`Unknown argument: ${argument}`);
  return [match[1], match[2] ?? true];
}));

if (args.has("help")) {
  usage();
  process.exit(0);
}

const origin = args.get("origin");
if (typeof origin !== "string" || origin === "") {
  process.stderr.write("readiness-cli: --origin=<http(s) origin> is required.\n");
  usage();
  process.exit(2);
}

try {
  const verdict = await probeReadiness(origin);
  process.stdout.write(`origin: ${verdict.origin}\n`);
  for (const name of READINESS_COMPONENTS) {
    const component = verdict.components[name];
    const detail = component.passed ? "" : ` — ${component.reason}`;
    process.stdout.write(`${name}: ${component.passed ? "PASS" : "FAIL"}${detail}\n`);
  }
  process.stdout.write(`readiness: ${verdict.ready ? "PASS" : "FAIL"}\n`);
  process.exit(verdict.ready ? 0 : 1);
} catch (error) {
  process.stderr.write(`readiness-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
