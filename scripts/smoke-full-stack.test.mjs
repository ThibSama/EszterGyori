#!/usr/bin/env node
/**
 * ESZ-124 — lifecycle tests for the disposable full-stack smoke
 * (`scripts/smoke-full-stack.mjs`, validate gate `php:smoke:full-stack`).
 *
 * The smoke is executed as a real child process — no mocks — and each test
 * proves that its disposable resources (the ESZ-112 MySQL container and the
 * scratch runtime root it prints) are gone after the run, whatever the
 * outcome: PASS, an assertion-style failure, or an interruption. The smoke's
 * own documented seams keep the failure and interruption cases deterministic:
 * `ESZTER_FULL_STACK_SMOKE_FAIL_STEP=after-stack` fails right after the
 * stack is live, and `ESZTER_FULL_STACK_SMOKE_PAUSE_MS` holds the process
 * with the stack live so a lifecycle test can SIGTERM it. The frontend build
 * is skipped for the children (`ESZTER_FULL_STACK_SMOKE_SKIP_BUILD=1`) and
 * performed once by the suite when front/out is missing.
 *
 * Docker-dependent tests are skipped honestly when no Docker engine, PHP
 * vendor or contract artifacts are available.
 *
 * Run: node --test scripts/smoke-full-stack.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";

import { dockerEngineAvailable } from "./sql-test-mysql.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const smokePath = join(scriptsDir, "smoke-full-stack.mjs");

const stackAvailable = dockerEngineAvailable()
  && existsSync(join(repoRoot, "php", "vendor", "autoload.php"))
  && existsSync(join(repoRoot, "contracts", "generated", "manifest.json"));

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: "pipe" });
  return { status: result.status, stdout: `${result.stdout ?? ""}`.trim(), stderr: `${result.stderr ?? ""}`.trim() };
}

function containerExists(name) {
  const result = docker(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]);
  return result.stdout === name;
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
    /** Resolves once `pattern` appears in the captured output. */
    waitFor: async (pattern, description, timeoutMs = 180_000) => {
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

/** Parses the disposable identities the child printed. */
function printedResources(combined) {
  const containers = [...combined.matchAll(/container ([a-z0-9][a-z0-9-]*)/g)].map((match) => match[1]);
  const scratchRoots = [...combined.matchAll(/scratch runtime state under (\S+)/g)].map((match) => match[1]);
  assert.ok(containers.length >= 1, "the smoke must print the disposable MySQL container identity");
  assert.ok(scratchRoots.length >= 1, "the smoke must print its scratch runtime root");
  return { containers, scratchRoots };
}

/** Asserts every printed disposable resource is gone. */
function assertNothingRemains(run) {
  const { containers, scratchRoots } = printedResources(run.combined());
  for (const name of containers) {
    assert.equal(containerExists(name), false, `container ${name} must be removed`);
  }
  for (const root of scratchRoots) {
    assert.equal(existsSync(root), false, `scratch root ${root} must be removed`);
  }
}

// ── Static wiring guards (pure) ────────────────────────────────────────────

test("the smoke is wired to the disposable primitive, never to the persistent dev stack", () => {
  const source = readFileSync(smokePath, "utf8");

  // The MySQL the smoke needs comes from the shared ESZ-112 disposable
  // primitive and is disposed through it.
  assert.match(source, /import \{ disposeSqlTestMySql, provisionSqlTestMySql \} from "\.\/sql-test-mysql\.mjs";/);

  // Scratch runtime state: never the persistent development layout.
  assert.match(source, /mkdtempSync\(join\(tmpdir\(\), SMOKE_WORK_PREFIX\)\)/);
  assert.match(source, /SMOKE_WORK_PREFIX = "eszter-full-stack-"/);

  // No functional reference to the persistent development stack or its
  // credentials: bootstrap-development.mjs drives compose.dev.yml and the
  // eszter_dev volume, and development-admin.json is the dev checkout's
  // credential file. Both are forbidden here.
  assert.doesNotMatch(source, /bootstrap-development\.mjs/);
  assert.doesNotMatch(source, /development-admin\.json/);
  assert.doesNotMatch(source, /compose\.dev\.yml[\s\S]*docker|docker[\s\S]*compose\.dev\.yml/);

  // The health wait is a LIVENESS wait (readiness.test.mjs wording contract).
  assert.match(source, /async function waitUntilLive/);
  assert.match(source, /did not become live/);

  // Cleanup is guaranteed on every exit path of the CLI: try/finally around
  // the whole run, with signal handlers that mark the run interrupted.
  assert.match(source, /process\.once\("SIGINT"/);
  assert.match(source, /process\.once\("SIGTERM"/);
  assert.match(source, /await handle\.cleanup\(\)/);
});

// ── Lifecycle: disposable resources are removed on every outcome ──────────

describe("ESZ-124 full-stack smoke lifecycle (needs Docker + PHP deps)", {
  skip: !stackAvailable
    && "no Docker engine, PHP vendor or contract artifacts are available",
}, () => {
  before(() => {
    // The children run with ESZTER_FULL_STACK_SMOKE_SKIP_BUILD=1; build the
    // export once when it is missing so a fresh checkout still exercises the
    // real flows.
    if (!existsSync(join(repoRoot, "front", "out", "index.html"))) {
      const built = spawnSync("npm", ["--prefix", "front", "run", "build"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      assert.equal(built.status, 0, "the frontend export could not be built");
    }
  });

  test("8a. a successful run removes every disposable resource", async () => {
    const run = spawnSmoke({ ESZTER_FULL_STACK_SMOKE_SKIP_BUILD: "1" });
    const { code } = await run.exited;
    assert.equal(code, 0, `smoke must pass:\n${run.combined()}`);
    assert.match(run.stdout(), /full-stack smoke: PASS —/);
    assert.match(run.stdout(), /stack live at http:\/\/127\.0\.0\.1:/);
    assertNothingRemains(run);
  });

  test("8b. an assertion-style failure removes every disposable resource", async () => {
    const run = spawnSmoke({
      ESZTER_FULL_STACK_SMOKE_SKIP_BUILD: "1",
      ESZTER_FULL_STACK_SMOKE_FAIL_STEP: "after-stack",
    });
    await run.waitFor(/stack live at http:\/\/127\.0\.0\.1:/, "the disposable stack must become live");
    const { code } = await run.exited;
    assert.equal(code, 1, `the injected failure must fail the smoke:\n${run.combined()}`);
    assert.match(run.combined(), /full-stack smoke: FAIL — injected failure after stack start/);
    assertNothingRemains(run);
  });

  test("8c. an interruption removes every disposable resource", async () => {
    const run = spawnSmoke({
      ESZTER_FULL_STACK_SMOKE_SKIP_BUILD: "1",
      ESZTER_FULL_STACK_SMOKE_PAUSE_MS: "600000",
    });
    await run.waitFor(/pausing 600000 ms with the stack live/, "the pause marker must appear");
    // The stack is fully provisioned at this point; interrupt it.
    run.child.kill("SIGTERM");
    const { code } = await run.exited;
    assert.equal(code, 130, `an interrupted smoke must exit 130:\n${run.combined()}`);
    assert.match(run.combined(), /SIGTERM received/);
    assert.match(run.combined(), /interrupted; disposable stack removed/);
    assertNothingRemains(run);
  });
});
