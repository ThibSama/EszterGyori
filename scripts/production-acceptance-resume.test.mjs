#!/usr/bin/env node
/**
 * ESZ-129 — production-acceptance core tests (file 2/3): booking-failure
 * compensation, the unresolved-cleanup debt gate and the cleanup/resume mode.
 *
 * Runs against its own disposable real PHP/MySQL full-stack fixture: each
 * fixture's fresh MySQL carries fresh ESZ-130/ESZ-084 rate-limit buckets (per
 * client address: 5 login burst, 3 booking-create burst, 10 anonymous session
 * bootstraps per hour), and this file stays under every ceiling (4 logins, 2
 * creates).
 *
 * Proves:
 *   3. a failure after booking creation cancels it through the admin surface
 *      with the current `expectedUpdatedAt` concurrency token;
 *   4. a cleanup failure writes a 0600 debt record, nothing secret leaks into
 *      the record or the output, and the next mutation run is blocked before
 *      any POST/upload/booking;
 *   5. the cleanup-only retry loads the debt, authenticates, retries the safe
 *      cleanup with authoritative re-queries and removes the debt only after
 *      every recorded resource is verified clean;
 *   6. successful compensation never converts the original failure to PASS.
 *
 * Run: node --test scripts/production-acceptance-resume.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { dockerEngineAvailable } from "./sql-test-mysql.mjs";
import { startSmokeStack } from "./smoke-full-stack.mjs";
import {
  DebtBlockedError,
  newAcceptanceMarker,
  runAuthorizedAcceptance,
  runCleanupAcceptance,
} from "./production-acceptance-core.mjs";
import {
  DEBT_FILE_MODE,
  readDebtRecord,
} from "./acceptance-debt.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

const stackAvailable = dockerEngineAvailable()
  && existsSync(join(repoRoot, "php", "vendor", "autoload.php"))
  && existsSync(join(repoRoot, "contracts", "generated", "manifest.json"));

const marker = () => newAcceptanceMarker();

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

describe("ESZ-129 acceptance core (file 2/3) against the disposable full-stack fixture", {
  skip: !stackAvailable
    && "no Docker engine, PHP vendor or contract artifacts are available",
}, () => {
  let stack = null;
  let origin;
  let credentials;
  let debtDir;
  let own;
  let runCounter = 0;

  const customerEmail = () => `resume+${process.pid}-${runCounter++}@example.test`;

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
    debtDir = mkdtempSync(join(tmpdir(), "esz129-resume-debt-"));
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
    const login = await call("/api/auth/login", {
      method: "POST", body: { email: credentials.email, password: credentials.password }, csrf: true,
    });
    assert.equal(login.status, 200);
    csrf = login.body?.csrfToken;
    own = { call };
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

  const bookingState = async (reference) => {
    const query = await own.call("/api/admin/bookings/query", {
      method: "POST", body: { mode: "reference", reference },
    });
    if (query.status === 404) return null;
    assert.equal(query.status, 200);
    return query.body?.booking?.state ?? null;
  };

  test("4. a failed compensation writes a 0600 debt; the next mutation run is blocked; nothing leaks", async () => {
    const runMarker = marker();
    const secretEmail = customerEmail();
    const captured = await captureOutput(() => run({
      marker: runMarker,
      customerEmail: secretEmail,
      faults: {
        "fail-after-booking-create": "injected",
        "fail-compensation-cancel": true,
      },
    }));
    const error = captured.outcome.ok ? null : captured.outcome.error;
    assert.ok(error, "the run must fail");
    assert.equal(error.compensated, false);
    assert.ok(error.debtPath, "an unresolved cleanup debt must be persisted");
    assert.equal(existsSync(error.debtPath), true);
    assert.equal(statSync(error.debtPath).mode & 0o777, DEBT_FILE_MODE);

    const debt = readDebtRecord(origin, debtDir);
    assert.ok(debt, "the debt must be readable");
    assert.equal(debt.origin, origin);
    assert.equal(debt.marker, runMarker);
    assert.equal(debt.steps.length, 1);
    assert.equal(debt.steps[0].kind, "booking");
    assert.equal(debt.steps[0].attempted, "cancel");
    assert.equal(debt.steps[0].status, "pending");
    const bookingRef = debt.steps[0].bookingReference;
    // The seam made the compensation cancel throw before sending: the booking
    // is still confirmed on the server.
    assert.equal(await bookingState(bookingRef), "confirmed");

    // No secrets/PII anywhere in the debt record or the run output.
    const serialized = JSON.stringify(debt);
    for (const secret of [credentials.email, credentials.password, secretEmail]) {
      assert.equal(serialized.includes(secret), false, "debt must not contain a secret/PII value");
      assert.equal(`${captured.stdout}${captured.stderr}`.includes(secret), false, "output must not leak a secret/PII value");
    }
    assert.doesNotMatch(`${captured.stdout}${captured.stderr}`, /x-csrf-token|set-cookie/i);

    // The next state-changing run is blocked before creating any new
    // mutation: it refuses with the debt verdict and leaves the pending
    // booking untouched.
    const blocked = await run({ marker: marker() }).then(() => null, (failure) => failure);
    assert.ok(blocked instanceof DebtBlockedError, "a state-changing run must refuse while debt exists");
    assert.match(blocked.message, /REFUSED: unresolved cleanup debt/);
    assert.equal(await bookingState(bookingRef), "confirmed", "the blocked run must not mutate anything");
  });

  test("5. the cleanup-only retry resolves and verifies the debt", async () => {
    const debt = readDebtRecord(origin, debtDir);
    assert.ok(debt, "the debt from the previous test must still exist");
    const bookingRef = debt.steps[0].bookingReference;
    assert.equal(await bookingState(bookingRef), "confirmed");

    const cleanup = await runCleanupAcceptance({
      origin,
      adminEmail: credentials.email,
      adminPassword: credentials.password,
      debtDir,
    });
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.debtRemoved, true);
    const bookingStep = cleanup.resolvedSteps.find((step) => step.kind === "booking");
    assert.ok(bookingStep && bookingStep.clean);
    assert.match(bookingStep.detail, /cancelled \(200\) with its current token/);
    assert.equal(await bookingState(bookingRef), "cancelled");
    assert.equal(readDebtRecord(origin, debtDir), null, "the debt must be gone after verified cleanup");
  });

  test("3 + 6. a failure after booking creation cancels it with the current token and still fails (never PASS)", async () => {
    const runMarker = marker();
    const injected = `assertion-style failure right after booking creation (${runMarker})`;
    const error = await run({
      marker: runMarker,
      faults: { "fail-after-booking-create": injected },
    }).then(() => null, (failure) => failure);
    assert.ok(error, "the compensated run must still fail, never PASS");
    assert.equal(error.code, "ACCEPTANCE_RUN_FAILED");
    assert.match(error.message, /assertion-style failure right after booking creation/);
    assert.equal(error.compensated, true);
    assert.equal(error.debtPath, null);
    const bookingStep = error.compensationSteps.find((step) => step.kind === "booking");
    assert.ok(bookingStep, "the booking step must have been compensated");
    assert.equal(bookingStep.clean, true);
    // The compensation cancelled through the admin surface with a freshly
    // queried token — the server answers 409 REVISION_CONFLICT and writes
    // nothing for a stale one, so a cancelled booking is the proof the token
    // was current.
    assert.match(bookingStep.detail, /cancelled \(200\) with its current token/);
    assert.equal(await bookingState(bookingStep.ref), "cancelled");
    const sessionStep = error.compensationSteps.find((step) => step.kind === "session");
    assert.ok(sessionStep && sessionStep.clean, "the acceptance session must be revoked");
    assert.equal(readDebtRecord(origin, debtDir), null);
  });
});
