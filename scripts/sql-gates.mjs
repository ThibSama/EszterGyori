#!/usr/bin/env node
/**
 * ESZ-112 — run the five SQL gates through the disposable-MySQL workflow.
 *
 * `npm run validate` runs every gate; this runs only the SQL stage, through the
 * exact same runner core (`runValidation` in `scripts/validate.mjs`) and the
 * exact same provisioning path (`scripts/sql-test-mysql.mjs`), so a focused
 * proof of the five SQL gates never drifts from what the canonical run does:
 *
 *   - when `ESZTER_TEST_DB_DSN` is set by the caller, it is used as-is;
 *   - otherwise one isolated MySQL 8.4 instance is provisioned for the run and
 *     removed on success, on failure and on interruption;
 *   - a SQL gate that cannot execute (provisioning failed, database unusable)
 *     reports FAIL — never NOT RUN.
 *
 * The gate ids are re-checked against the declarations in `validate.mjs` at
 * startup, so a renamed or removed gate fails loudly here instead of silently
 * running nothing.
 */

import { runValidation, gates, sqlDatabaseUnavailable } from "./validate.mjs";

const SQL_GATE_IDS = [
  "sql:migrations",
  "sql:integration",
  "sql:rate-limits",
  "sql:backup-restore",
  "sql:notifications",
];

for (const id of SQL_GATE_IDS) {
  const gate = gates.find((candidate) => candidate.id === id);
  if (!gate) {
    throw new Error(`sql-gates: no gate named \`${id}\` is declared in scripts/validate.mjs`);
  }
  if (gate.unavailable !== sqlDatabaseUnavailable) {
    throw new Error(`sql-gates: \`${id}\` is no longer a SQL-stage gate; update this list`);
  }
}

process.exitCode = (await runValidation({ ids: SQL_GATE_IDS })).code;
