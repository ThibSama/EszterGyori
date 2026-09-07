#!/usr/bin/env node
/**
 * ESZ-143 — the deployment runbook as a machine-readable procedure.
 *
 * The production build used to exist twice: once as prose in
 * `docs/deployment-runbook.md` and once as the real scripts. The two drifted
 * (the runbook told the operator to run `package:production` and
 * `verify:production-artifact`, neither of which has ever existed in
 * `package.json`), and nothing executable could notice.
 *
 * This module makes the documentation the source of truth for exactly two
 * things, so there is one command truth rather than two:
 *
 *   - the canonical production build procedure, read from the single fenced
 *     block marked `<!-- runbook:production-build -->`. The procedure test
 *     executes those lines verbatim in a clean checkout, so a documented
 *     command that does not exist, or a missing prerequisite step, fails a
 *     gate instead of failing an operator on deployment day;
 *   - the set of `app/bin/*.php` commands the runbook tells a deployed
 *     operator to invoke, read from its shell blocks. Every one of them must
 *     be packaged into the artifact and must pass a no-network usage smoke,
 *     so the runbook cannot document a command the release does not carry.
 *
 * `PRODUCTION_OPERATOR_COMMANDS` is the packaging-side list, imported by both
 * the builder and the verifier. The procedure test asserts it equals what the
 * runbook asks for, which is what keeps documentation and artifact in
 * agreement without a second hand-maintained copy of either.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Path of the operator runbook, relative to the repository root. */
export const RUNBOOK_RELATIVE_PATH = "docs/deployment-runbook.md";

/** Marker preceding the one fenced block that defines the build procedure. */
export const BUILD_PROCEDURE_MARKER = "<!-- runbook:production-build -->";

/**
 * PHP operator commands packaged into `app/bin/` of the production artifact.
 *
 * Exactly the V1 deployment procedure: host preflight, schema migration, the
 * two provisioning commands, the notification and retention cron commands,
 * log maintenance, and backup/restore. Development bootstrap, linting,
 * static analysis, htaccess generation and contract syncing are build-time
 * repository tooling and are deliberately absent — an artifact is not a
 * development checkout.
 */
export const PRODUCTION_OPERATOR_COMMANDS = Object.freeze([
  "apply-booking-retention.php",
  "backup.php",
  "maintain-logs.php",
  "migrate.php",
  "preflight-production.php",
  "provision-admin.php",
  "provision-booking-service.php",
  "restore.php",
  "run-notification-jobs.php",
]);

/** Read the runbook of a checkout (defaults to this repository). */
export function readRunbook(root = repoRoot) {
  return readFileSync(join(root, RUNBOOK_RELATIVE_PATH), "utf8");
}

/** Every fenced code block body of a Markdown document, in document order. */
export function fencedBlocks(markdown) {
  const blocks = [];
  const pattern = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push({ info: match[1].trim(), body: match[2], index: match.index });
  }
  return blocks;
}

/**
 * The canonical production build procedure: the shell lines of the single
 * block marked `<!-- runbook:production-build -->`.
 *
 * Fail-closed. A missing marker, a marker not followed by a shell fence, more
 * than one marker, a continuation line or an empty procedure throws: the
 * procedure test must never silently execute nothing and report success.
 */
export function productionBuildProcedure(markdown = readRunbook()) {
  const markers = [...markdown.matchAll(new RegExp(escapeForRegExp(BUILD_PROCEDURE_MARKER), "g"))];
  if (markers.length !== 1) {
    throw new Error(
      `${RUNBOOK_RELATIVE_PATH} must contain exactly one ${BUILD_PROCEDURE_MARKER} marker; found ${markers.length}`,
    );
  }
  const markerEnd = markers[0].index + BUILD_PROCEDURE_MARKER.length;
  const block = fencedBlocks(markdown).find((candidate) => candidate.index > markerEnd);
  if (block === undefined || markdown.slice(markerEnd, block.index).trim() !== "") {
    throw new Error(`${BUILD_PROCEDURE_MARKER} must be followed immediately by a fenced command block`);
  }
  if (block.info !== "sh") {
    throw new Error(`the production build block must be a \`sh\` fence; found \`${block.info}\``);
  }
  const commands = block.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (commands.length === 0) {
    throw new Error("the production build block declares no command");
  }
  for (const command of commands) {
    if (command.endsWith("\\")) {
      throw new Error(`the production build block must hold one whole command per line: ${command}`);
    }
  }
  return commands;
}

/**
 * The `bin/*.php` commands the runbook tells a deployed operator to run,
 * read from its shell blocks only — prose naming a file is documentation,
 * an invocation in a command block is a promise the artifact must keep.
 */
export function runbookOperatorCommands(markdown = readRunbook()) {
  const found = new Set();
  for (const block of fencedBlocks(markdown)) {
    if (block.info !== "sh") continue;
    for (const match of block.body.matchAll(/(?:^|[\s/])bin\/([a-z0-9-]+\.php)\b/g)) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
}

/**
 * Split one documented command line into argv, without a shell.
 *
 * The procedure test runs these commands directly, so the runbook may only
 * document plain whitespace-separated invocations: no pipe, redirection,
 * substitution, glob or variable can appear in the executable block. That is
 * a deliberate restriction — a documented build step that needs a shell is a
 * step the test would have to reimplement, which is how the two truths
 * diverged in the first place.
 */
export function parseProcedureCommand(command) {
  if (/[|&;<>()$`\\"'*?[\]{}]/.test(command)) {
    throw new Error(`the production build block must hold plain commands only: ${command}`);
  }
  const argv = command.split(/\s+/).filter(Boolean);
  if (argv.length === 0) throw new Error(`empty command in the production build block: ${command}`);
  return argv;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
