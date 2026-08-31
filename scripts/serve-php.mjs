#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const value = (name, fallback) =>
  process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1)
  ?? fallback;

const host = value("--host", "127.0.0.1");
const port = value("--port", "8080");
const skipBuild = args.has("--skip-build");
const skipBootstrap = args.has("--skip-bootstrap");
const developmentConfig = join(repoRoot, "php", "config", "config.development.php");
const configuredPath = process.env.ESZTER_CONFIG ?? developmentConfig;

if (!/^[A-Za-z0-9.:-]+$/.test(host) || !/^\d{1,5}$/.test(port) || Number(port) > 65535) {
  process.stderr.write("php:serve: invalid --host or --port value.\n");
  process.exit(2);
}

// The canonical development server is full-stack. An explicit ESZTER_CONFIG is
// respected and never mutated; the project-owned development config bootstraps
// MySQL and deterministic fixtures unless a caller deliberately opts out.
if (!skipBootstrap && resolve(configuredPath) === resolve(developmentConfig)) {
  process.stdout.write("php:serve: preparing the full development stack...\n");
  const bootstrap = spawnSync("node", ["scripts/bootstrap-development.mjs", "--quiet"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (bootstrap.error) throw bootstrap.error;
  if (bootstrap.status !== 0) process.exit(bootstrap.status ?? 1);
}

if (!skipBuild) {
  process.stdout.write("php:serve: building the static frontend export...\n");
  const build = spawnSync("npm", ["--prefix", "front", "run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const required = [
  [join(repoRoot, "php", "vendor", "autoload.php"), "Composer dependencies (run `composer install --working-dir=php`)"],
  [join(repoRoot, "front", "out", "index.html"), "frontend export (run without `--skip-build`)"],
  [configuredPath, "application configuration"],
  [join(repoRoot, "php", "public", "router.php"), "development router"],
];

for (const [path, description] of required) {
  if (!existsSync(path)) {
    process.stderr.write(`php:serve: missing ${description}: ${path}\n`);
    process.exit(1);
  }
}

const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
process.stdout.write(`php:serve: starting Eszter at ${url}\n`);

const server = spawn(
  "php",
  [
    "-S",
    `${host}:${port}`,
    "-t",
    join(repoRoot, "front", "out"),
    join(repoRoot, "php", "public", "router.php"),
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      ESZTER_CONFIG: configuredPath,
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

server.on("error", (error) => {
  process.stderr.write(`php:serve: could not start PHP: ${error.message}\n`);
  process.exitCode = 1;
});
server.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
