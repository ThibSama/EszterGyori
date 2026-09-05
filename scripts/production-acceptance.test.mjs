#!/usr/bin/env node
/**
 * ESZ-129 — production-acceptance core tests (file 1/3) against the
 * disposable real PHP/MySQL full-stack fixture (`scripts/smoke-full-stack.mjs`'s
 * `startSmokeStack`, ESZ-124), plus the CLI authorization boundary.
 *
 * The acceptance core is driven directly against the fixture's plain HTTP
 * loopback origin (the public CLI itself keeps rejecting non-HTTPS targets
 * and requiring the live authorization — proven in the boundary tests below).
 * The deterministic fault seams are options of the core call, never
 * environment variables, so the CLI cannot activate them.
 *
 * This file proves:
 *   1. a successful mutation pass leaves media absent, the booking cancelled,
 *      the session invalidated and no debt;
 *   2. a failure after media creation cleans it automatically — and the
 *      original failure is never converted to PASS.
 *
 * The fixture's fresh MySQL carries fresh ESZ-130/ESZ-084 rate-limit buckets
 * (per client address: 5 login burst, 3 booking-create burst, 10 anonymous
 * session bootstraps per hour), so the state-changing proofs are split across
 * three files, each with its own disposable stack and each comfortably under
 * every ceiling:
 *   - this file: proofs 1-2 (+ the CLI boundary, which needs no stack);
 *   - `production-acceptance-resume.test.mjs`: proofs 3-6;
 *   - `production-acceptance-idempotency.test.mjs`: proofs 7-8 and the
 *     debt → cleanup → new-run lifecycle.
 *
 * Run: node --test scripts/production-acceptance.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { dockerEngineAvailable } from "./sql-test-mysql.mjs";
import { startSmokeStack } from "./smoke-full-stack.mjs";
import {
  newAcceptanceMarker,
  runAuthorizedAcceptance,
} from "./production-acceptance-core.mjs";
import { readDebtRecord } from "./acceptance-debt.mjs";
import { main as cliMain } from "./production-acceptance.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

const stackAvailable = dockerEngineAvailable()
  && existsSync(join(repoRoot, "php", "vendor", "autoload.php"))
  && existsSync(join(repoRoot, "contracts", "generated", "manifest.json"));

const marker = () => newAcceptanceMarker();

/** Independent admin client: its own session, cookies and CSRF token. */
async function adminClient(origin, email, password) {
  const cookies = new Map();
  let csrf = null;
  const call = async (path, { method = "GET", body, csrf: withCsrf = false } = {}) => {
    const headers = { accept: "application/json" };
    if (cookies.size) {
      headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    if (withCsrf) headers["x-csrf-token"] = csrf;
    const response = await fetch(new URL(path, origin), {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const value of response.headers.getSetCookie?.() ?? []) {
      const [pair] = value.split(";", 1);
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue === "" || /max-age=0/i.test(value)) cookies.delete(name);
      else cookies.set(name, cookieValue);
    }
    const text = await response.text();
    let parsed = null;
    if (text && response.headers.get("content-type")?.includes("application/json")) {
      parsed = JSON.parse(text);
    }
    return { status: response.status, body: parsed, text };
  };
  const session = await call("/api/auth/session");
  assert.equal(session.status, 200);
  csrf = session.body?.csrfToken;
  const login = await call("/api/auth/login", { method: "POST", body: { email, password }, csrf: true });
  assert.equal(login.status, 200);
  csrf = login.body?.csrfToken;
  return { call };
}

/** Captures every stdout/stderr byte written during one async operation. */
async function captureOutput(operation) {
  const out = [];
  const err = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk, ...rest) => { err.push(String(chunk)); return true; };
  let outcome;
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
  return { stdout: out.join(""), stderr: err.join(""), outcome };
}

describe("ESZ-129 acceptance core (file 1/3) against the disposable full-stack fixture", {
  skip: !stackAvailable
    && "no Docker engine, PHP vendor or contract artifacts are available",
}, () => {
  let stack = null;
  let origin;
  let credentials;
  let debtDir;
  let own;
  let runCounter = 0;

  const customerEmail = () => `acceptance+${process.pid}-${runCounter++}@example.test`;

  before(async () => {
    if (!existsSync(join(repoRoot, "front", "out", "index.html"))) {
      const built = spawnSync("npm", ["--prefix", "front", "run", "build"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      assert.equal(built.status, 0, "the frontend export could not be built");
    }
    stack = await startSmokeStack({ skipBuild: true });
    origin = stack.baseUrl;
    credentials = stack.credentials;
    debtDir = mkdtempSync(join(tmpdir(), "esz129-acceptance-debt-"));
    own = await adminClient(origin, credentials.email, credentials.password);
  });

  after(async () => {
    if (stack !== null) {
      await stack.cleanup();
      stack = null;
    }
  });

  const run = (overrides = {}) => runAuthorizedAcceptance({
    origin,
    adminEmail: credentials.email,
    adminPassword: credentials.password,
    customerEmail: customerEmail(),
    debtDir,
    ...overrides,
  });

  const listAssets = async () => {
    const list = await own.call("/api/admin/media");
    assert.equal(list.status, 200);
    return list.body?.assets ?? [];
  };

  const bookingState = async (reference) => {
    const query = await own.call("/api/admin/bookings/query", {
      method: "POST", body: { mode: "reference", reference },
    });
    if (query.status === 404) return null;
    assert.equal(query.status, 200);
    return query.body?.booking?.state ?? null;
  };

  test("1. a successful mutation pass verifies media absent, booking cancelled, session logged out; no debt", async () => {
    const result = await run({ marker: marker() });
    assert.deepEqual(result.verifications, {
      mediaAbsent: true, bookingCancelled: true, sessionLoggedOut: true,
    });
    // Authoritative re-checks through an independent admin session.
    assert.equal(
      (await listAssets()).some((asset) => asset.id === result.mediaId),
      false,
      "the uploaded media must be absent from the admin media library",
    );
    assert.equal(
      await bookingState(result.bookingReference),
      "cancelled",
      "the booking must be cancelled through the admin surface",
    );
    assert.equal(readDebtRecord(origin, debtDir), null, "no debt may exist after a clean run");
  });

  test("2. a failure after media creation cleans it automatically and still fails (never PASS)", async () => {
    const runMarker = marker();
    const injected = `injected failure right after media upload (${runMarker})`;
    const error = await run({
      marker: runMarker,
      faults: { "fail-after-media-upload": injected },
    }).then(() => null, (failure) => failure);
    assert.ok(error, "the injected failure must reject the run, not PASS it");
    assert.equal(error.code, "ACCEPTANCE_RUN_FAILED");
    assert.equal(error.message.includes(injected), true, "the original failure must be the one reported");
    assert.equal(error.compensated, true, "compensation must be complete");
    assert.equal(error.debtPath, null);
    const mediaStep = error.compensationSteps.find((step) => step.kind === "media");
    assert.ok(mediaStep, "the media step must have been compensated");
    assert.equal(mediaStep.clean, true);
    assert.match(mediaStep.detail, /deleted \(204\) and verified absent/);
    // The flow never reached the booking creation: no booking step exists.
    assert.equal(error.compensationSteps.some((step) => step.kind === "booking"), false);
    assert.equal(
      (await listAssets()).some((asset) => asset.id === mediaStep.ref),
      false,
      "the failed run's media must be gone",
    );
    assert.equal(readDebtRecord(origin, debtDir), null);
  });
});

// ── CLI authorization boundary (no stack needed) ──────────────────────────

const CLI_ARGS = ["--live-confirmation=I_AUTHORIZE_ESZTER_LIVE_MUTATIONS"];
const SCRATCH_ENV = { ESZTER_ACCEPTANCE_DEBT_DIR: mkdtempSync(join(tmpdir(), "esz129-cli-debt-")) };

describe("ESZ-129 CLI authorization boundary", () => {
  test("--help exits 0 and documents the exact confirmation phrase and --cleanup", async () => {
    const code = await cliMain(["--help"], SCRATCH_ENV);
    assert.equal(code, 0);
  });

  test("a non-HTTPS target is rejected", async () => {
    const code = await cliMain([], {
      ...SCRATCH_ENV,
      ESZTER_ACCEPTANCE_TARGET_URL: "http://127.0.0.1:8099/",
    });
    assert.equal(code, 1);
  });

  test("a target with embedded credentials, query or path is rejected", async () => {
    for (const url of [
      "https://user:pass@example.com/",
      "https://example.com/?a=1",
      "https://example.com/root",
    ]) {
      const code = await cliMain([], { ...SCRATCH_ENV, ESZTER_ACCEPTANCE_TARGET_URL: url });
      assert.equal(code, 1, `target ${url} must be rejected`);
    }
  });

  test("without the exact phrase the run is READ-ONLY and never enters the state-changing path", async () => {
    const captured = await captureOutput(() => cliMain([], {
      ...SCRATCH_ENV,
      ESZTER_ACCEPTANCE_TARGET_URL: "https://127.0.0.1:1/", // refused: proves no mutation path
    }));
    assert.equal(captured.outcome.value, 1);
    assert.match(captured.stdout, /Mode: READ-ONLY/);
    assert.doesNotMatch(captured.stdout, /AUTHORIZED STATE-CHANGING/);
    assert.doesNotMatch(captured.stdout, /login|upload|booking created/i);
  });

  test("with the phrase but no secrets the run is refused as usage (secrets only from the environment)", async () => {
    const code = await cliMain(CLI_ARGS, {
      ...SCRATCH_ENV,
      ESZTER_ACCEPTANCE_TARGET_URL: "https://127.0.0.1:1/",
      // no ESZTER_ACCEPTANCE_ADMIN_* / CUSTOMER_EMAIL
    });
    assert.equal(code, 2);
  });

  test("cleanup mode requires the exact phrase too, and refuses before any network call otherwise", async () => {
    const captured = await captureOutput(() => cliMain(["--cleanup"], {
      ...SCRATCH_ENV,
      ESZTER_ACCEPTANCE_TARGET_URL: "https://127.0.0.1:1/",
    }));
    assert.equal(captured.outcome.value, 1);
    assert.match(captured.stderr, /state-changing cleanup requires the exact --live-confirmation/);
  });

  test("authorized mode against an unreachable origin fails at readiness without ever mutating", async () => {
    const captured = await captureOutput(() => cliMain(CLI_ARGS, {
      ...SCRATCH_ENV,
      ESZTER_ACCEPTANCE_TARGET_URL: "https://127.0.0.1:1/",
      ESZTER_ACCEPTANCE_ADMIN_EMAIL: "admin@example.test",
      ESZTER_ACCEPTANCE_ADMIN_PASSWORD: "secret",
      ESZTER_ACCEPTANCE_CUSTOMER_EMAIL: "customer@example.test",
    }));
    assert.equal(captured.outcome.value, 1);
    assert.match(captured.stdout, /Mode: AUTHORIZED STATE-CHANGING/);
    assert.match(captured.stderr, /readiness probe FAILED/);
  });
});

test("the CLI never reads fault seams from the environment (test-only options live in the core)", () => {
  const cliSource = readFileSync(join(scriptsDir, "production-acceptance.mjs"), "utf8");
  assert.doesNotMatch(cliSource, /fail-after-media-upload|fail-after-booking-create|fail-compensation-cancel|fail-compensation-logout/);
  assert.doesNotMatch(cliSource, /process\.env\.\w*FAULT|ESZTER_ACCEPTANCE_FAULT/i);
  assert.match(cliSource, /runAuthorizedAcceptance|runCleanupAcceptance/);
});
