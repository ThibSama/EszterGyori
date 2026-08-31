#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const reset = process.argv.includes("--reset");
const composeFile = join(repoRoot, "compose.dev.yml");
const configFile = join(repoRoot, "php", "config", "config.development.php");
const credentialsFile = join(repoRoot, "php", "var", "development", "development-admin.json");

function log(message) {
  if (!quiet) process.stdout.write(`${message}\n`);
}

function run(command, args, { inherit = true, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: inherit ? "inherit" : "pipe",
    encoding: "utf8",
  });
  if (result.error) {
    if (allowFailure) return result;
    throw new Error(`${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = inherit ? "" : `\n${result.stderr || result.stdout || ""}`;
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}.${detail}`);
  }
  return result;
}

function ensureDependencies() {
  if (!existsSync(join(repoRoot, "php", "vendor", "autoload.php"))) {
    log("dev:bootstrap: installing Composer dependencies...");
    run("composer", ["install", "--working-dir=php", "--no-interaction"]);
  }
  if (!existsSync(join(repoRoot, "contracts", "node_modules"))) {
    log("dev:bootstrap: installing contract dependencies...");
    run("npm", ["--prefix", "contracts", "ci"]);
  }
  if (!existsSync(join(repoRoot, "front", "node_modules"))) {
    log("dev:bootstrap: installing frontend dependencies...");
    run("npm", ["--prefix", "front", "ci"]);
  }
}

async function waitForMysql() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ping = run(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "exec",
        "-T",
        "mysql",
        "sh",
        "-lc",
        'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent',
      ],
      { inherit: false, allowFailure: true },
    );
    if (ping.status === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error("project-owned MySQL did not become healthy within 60 seconds.");
}

try {
  run("docker", ["compose", "version"], { inherit: false });
  if (reset) {
    log("dev:bootstrap: removing the development database volume...");
    run("docker", ["compose", "-f", composeFile, "down", "-v"]);
  }

  ensureDependencies();

  log("dev:bootstrap: starting project-owned MySQL...");
  run("docker", ["compose", "-f", composeFile, "up", "-d", "mysql"]);
  await waitForMysql();

  log("dev:bootstrap: applying forward-only migrations...");
  run("php", ["php/bin/migrate.php", `--config=${configFile}`]);

  log("dev:bootstrap: provisioning deterministic development fixtures...");
  run("php", [
    "php/bin/bootstrap-development.php",
    `--config=${configFile}`,
    `--credentials-file=${credentialsFile}`,
  ]);

  if (!quiet) {
    process.stdout.write("\nDevelopment stack ready.\n");
    process.stdout.write("  Start:       npm run php:serve\n");
    process.stdout.write("  Full smoke:  npm run php:smoke:full-stack\n");
    process.stdout.write(`  Admin login: admin@eszter.test (password in ${credentialsFile})\n`);
    process.stdout.write("  Stop MySQL:  npm run dev:down\n");
  }
} catch (error) {
  process.stderr.write(`dev:bootstrap: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
