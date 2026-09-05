#!/usr/bin/env node
/**
 * ESZ-114 — lifecycle and wiring tests for the packaged-artifact Apache smoke
 * (`scripts/smoke-apache.mjs`, validate gate `smoke:apache`).
 *
 * The smoke is executed as a real child process — no mocks — and each test
 * proves that its disposable resources are gone after the run, whatever the
 * outcome: the Apache and MySQL containers it prints, the docker network, the
 * Chrome process, the temp extractions and the HTTP ports they occupied. The
 * smoke's documented seam keeps the failure case deterministic:
 * `ESZTER_SMOKE_APACHE_FAIL_STEP=after-stack` fails right after the pristine
 * stack is live. The children reuse an already-built artifact
 * (`ESZTER_SMOKE_APACHE_SKIP_BUILD=1`) — the real build+attest path is proven
 * by `npm run smoke:apache` itself (which must run on a clean committed tree,
 * ESZ-126), and this suite skips honestly when that artifact is missing.
 *
 * Run: node --test scripts/smoke-apache.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { dockerEngineAvailable } from "./sql-test-mysql.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const smokePath = join(scriptsDir, "smoke-apache.mjs");
const archivePath = join(repoRoot, "dist", "eszter-production.tar.gz");

const stackAvailable = dockerEngineAvailable()
  && existsSync(archivePath);

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: "pipe" });
  return { status: result.status, stdout: `${result.stdout ?? ""}`.trim(), stderr: `${result.stderr ?? ""}`.trim() };
}

function containerExists(name) {
  const result = docker(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]);
  return result.stdout === name;
}

function networkExists(name) {
  const result = docker(["network", "inspect", name]);
  return result.status === 0;
}

/** Spawns the smoke CLI with captured stdout/stderr. */
function spawnSmoke(extraEnv = {}) {
  const child = spawn(process.execPath, [smokePath], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return {
    child,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    combined: () => `${stdout}\n${stderr}`,
    waitFor: async (pattern, description, timeoutMs = 240_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(`${stdout}\n${stderr}`)) return;
        if (child.exitCode !== null && child.signalCode !== null) {
          throw new Error(`${description}: process ended before the marker appeared (exit ${child.exitCode})`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      throw new Error(`${description}: marker ${pattern} never appeared within ${timeoutMs} ms`);
    },
  };
}

/**
 * Parses the disposable identities and origins the child printed. `partial`
 * is for the forced-failure child, which dies right after the pristine stack
 * (one Apache container, one extraction, one origin).
 */
function printedResources(combined, { partial = false } = {}) {
  const containers = [...combined.matchAll(/container ([a-z0-9][a-z0-9-]*)/g)].map((match) => match[1]);
  const scratchRoots = [...combined.matchAll(/scratch runtime state under (\S+)/g)].map((match) => match[1]);
  const origins = [...combined.matchAll(/origin (http:\/\/127\.0\.0\.1:\d+)/g)].map((match) => match[1]);
  const minimum = partial ? 1 : 2;
  assert.ok(containers.length >= minimum, "the smoke must print its container identities");
  assert.ok(scratchRoots.length >= minimum, "the smoke must print its scratch extraction root(s)");
  assert.ok(origins.length >= minimum, "the smoke must print its live origin(s)");
  return { containers, scratchRoots, origins };
}

/** Tries to bind one TCP port; resolves true when the bind succeeds (port free). */
function portIsFree(port) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => resolvePort(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolvePort(true));
    });
  });
}

/** Asserts every printed disposable resource is gone and no esz114 residue exists. */
async function assertNothingRemains(run, { partial = false } = {}) {
  const { containers, scratchRoots, origins } = printedResources(run.combined(), { partial });

  for (const name of containers) {
    assert.equal(containerExists(name), false, `container ${name} must be removed`);
    // Every stack also created a docker network named <prefix>_net.
    const prefix = name.replace(/_(?:apache|mysql)$/, "");
    assert.equal(networkExists(`${prefix}_net`), false, `network ${prefix}_net must be removed`);
  }
  for (const root of scratchRoots) {
    assert.equal(existsSync(root), false, `scratch root ${root} must be removed`);
  }

  // No occupied port: every published origin must be bindable again.
  for (const origin of origins) {
    const port = Number(new URL(origin).port);
    assert.equal(await portIsFree(port), true, `port ${port} (${origin}) is still occupied`);
  }

  // Broad sweep: nothing esz114-shaped remains — containers, networks, temp
  // extraction dirs, Chrome processes (the profile lived under a scratch root).
  const residueContainers = docker(["ps", "-a", "--format", "{{.Names}}"]).stdout
    .split("\n").filter((name) => /^esz114/.test(name));
  assert.deepEqual(residueContainers, [], `residual esz114 containers: ${residueContainers.join(", ")}`);
  const residueNetworks = docker(["network", "ls", "--format", "{{.Name}}"]).stdout
    .split("\n").filter((name) => /^esz114/.test(name));
  assert.deepEqual(residueNetworks, [], `residual esz114 networks: ${residueNetworks.join(", ")}`);

  const chrome = spawnSync("pgrep", ["-af", "eszter-apache-esz114.*chrome-profile"]);
  assert.notEqual(chrome.status, 0, `a Chrome process survives with a smoke profile:\n${chrome.stdout}`);
}

// ── Static wiring guards (pure) ────────────────────────────────────────────

test("the smoke serves the packaged artifact under Apache, reusing the shared fixture", () => {
  const source = readFileSync(smokePath, "utf8");

  // The gate builds and attests the packaged artifact (ESZ-126 provenance),
  // never a copy of the source tree.
  assert.match(source, /build-production-artifact\.mjs/);
  assert.match(source, /verify-production-artifact\.mjs/);
  assert.match(source, /--expect-commit/);
  assert.match(source, /resolveHeadCommit/);

  // Docker/CDP orchestration is reused from the shared browser fixture, not
  // cloned: no cpSync of front/out or php/public, no second CdpClient. (The
  // source may mention `front/out` only inside comments — no code path reads
  // it.)
  assert.match(source, /from "\.\/browser-stack\.mjs"/);
  assert.match(source, /launchChrome/);
  assert.doesNotMatch(source, /cpSync/);
  assert.doesNotMatch(source, /readFileSync\([^)]*front[^)]*out[^)]*\)/);
  assert.doesNotMatch(source, /cpSync\s*\(/);
  assert.doesNotMatch(source, /class CdpClient/);

  // Never the persistent development stack (the header docblock may state
  // that intent in prose — the wiring guards below are the functional ones).
  assert.doesNotMatch(source, /bootstrap-development\.mjs/);
  assert.doesNotMatch(source, /compose\.dev\.yml/);
  assert.doesNotMatch(source, /development-admin\.json/);

  // The committed deny classes are proved as 403 policy with planted canaries
  // (a dot-directory is invisible to a basename deny), and media/ whitelists
  // the managed name shape.
  assert.match(source, /\.git\/config/);
  assert.match(source, /med_[0-9a-f]{32}/);
  assert.match(source, /expectDenied\(origin/);
  assert.match(source, /403/);

  // Cleanup runs on every exit path: signal handlers plus finally hooks.
  assert.match(source, /process\.once\("SIGINT"/);
  assert.match(source, /process\.once\("SIGTERM"/);
  assert.match(source, /smoke:apache: PASS —/);
});

// ── Lifecycle: disposable resources are removed on every outcome ──────────

describe("ESZ-114 apache smoke lifecycle (needs Docker + a built dist artifact)", {
  skip: !stackAvailable
    && "no Docker engine or no dist/eszter-production.tar.gz (run npm run smoke:apache first on a clean tree)",
}, () => {
  test("a successful run removes every disposable resource", async () => {
    const run = spawnSmoke({ ESZTER_SMOKE_APACHE_SKIP_BUILD: "1" });
    const { code } = await run.exited;
    assert.equal(code, 0, `smoke must pass:\n${run.combined()}`);
    assert.match(run.stdout(), /smoke:apache: PASS —/);
    assert.match(run.stdout(), /pristine stack live at http:\/\/127\.0\.0\.1:/);
    assert.match(run.stdout(), /canary stack live at http:\/\/127\.0\.0\.1:/);
    assert.match(run.stdout(), /real migrations applied to the disposable MySQL/);
    await assertNothingRemains(run);
  });

  test("a forced failure removes every disposable resource", async () => {
    const run = spawnSmoke({
      ESZTER_SMOKE_APACHE_SKIP_BUILD: "1",
      ESZTER_SMOKE_APACHE_FAIL_STEP: "after-stack",
    });
    await run.waitFor(/pristine stack live at http:\/\/127\.0\.0\.1:/, "the pristine stack must become live");
    const { code } = await run.exited;
    assert.equal(code, 1, `the injected failure must fail the smoke:\n${run.combined()}`);
    assert.match(run.combined(), /injected failure after the pristine stack came up/);
    assert.match(run.combined(), /apache smoke: FAIL — disposable stack removed\./);
    await assertNothingRemains(run, { partial: true });
  });
});
