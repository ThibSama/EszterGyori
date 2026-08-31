#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, cwd = repoRoot) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });
}

function version(command, args) {
  const result = run(command, args);
  if (result.error || result.status !== 0) {
    throw new Error(`${command} version check failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim().split("\n")[0];
}

function parseAudit(label, command, args, cwd, summarize) {
  const result = run(command, args, cwd);
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not return JSON (exit ${result.status}): ${result.stderr.trim()}`);
  }

  const summary = summarize(report);
  process.stdout.write(`${label}: ${summary}\n`);
  if (result.status !== 0) {
    process.stderr.write(`${label} failed (exit ${result.status}).\n${result.stdout}`);
    process.exitCode = 1;
  }
}

try {
  process.stdout.write("Dependency advisory gate (online authoritative registries)\n");
  process.stdout.write(`node: ${version("node", ["--version"])}\n`);
  process.stdout.write(`npm: ${version("npm", ["--version"])}\n`);
  process.stdout.write(`composer: ${version("composer", ["--version", "--no-ansi"])}\n`);

  for (const noDev of [false, true]) {
    parseAudit(
      `Composer lock (${noDev ? "production" : "complete"})`,
      "composer",
      [
        "audit",
        "--locked",
        ...(noDev ? ["--no-dev"] : []),
        "--format=json",
        "--abandoned=fail",
        "--no-interaction",
      ],
      resolve(repoRoot, "php"),
      (report) => {
        const advisoryCount = Object.values(report.advisories ?? {}).reduce(
          (total, advisories) => total + (Array.isArray(advisories) ? advisories.length : 1),
          0,
        );
        const abandoned = report.abandoned ?? [];
        const abandonedCount = Array.isArray(abandoned) ? abandoned.length : Object.keys(abandoned).length;
        return `${advisoryCount} advisories, ${abandonedCount} abandoned packages`;
      },
    );
  }

  for (const workspace of ["contracts", "front"]) {
    for (const production of [false, true]) {
      parseAudit(
        `npm ${workspace} lock (${production ? "production" : "complete"})`,
        "npm",
        ["audit", "--package-lock-only", ...(production ? ["--omit=dev"] : []), "--json"],
        resolve(repoRoot, workspace),
        (report) => {
          const vulnerabilities = report.metadata?.vulnerabilities ?? {};
          return `${vulnerabilities.total ?? "?"} advisories (critical ${vulnerabilities.critical ?? "?"}, high ${vulnerabilities.high ?? "?"}, moderate ${vulnerabilities.moderate ?? "?"}, low ${vulnerabilities.low ?? "?"})`;
        },
      );
    }
  }
} catch (error) {
  process.stderr.write(`security:dependencies: ${error.message}\n`);
  process.exitCode = 1;
}
