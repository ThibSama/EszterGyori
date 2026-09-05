#!/usr/bin/env node
/**
 * ESZ-129 — production-acceptance core tests (file 3/3): cleanup
 * idempotency, the credentials boundary of the cleanup mode and the
 * session-only debt path, ending with the proof that a resolved debt permits
 * a new state-changing run.
 *
 * Runs against its own disposable real PHP/MySQL full-stack fixture: each
 * fixture's fresh MySQL carries fresh ESZ-130/ESZ-084 rate-limit buckets (per
 * client address: 5 login burst, 3 booking-create burst, 10 anonymous session
 * bootstraps per hour), and this file stays exactly under every ceiling (5
 * logins, 3 creates, 5 bootstraps).
 *
 * Proves:
 *   7.  cleanup is idempotent — already-deleted media, already-cancelled
 *       bookings and absent bookings verify clean and are never re-mutated
 *       or reported as errors;
 *   7b. cleanup of a debt with a booking step refuses without credentials and
 *       a new mutation run stays blocked while the debt exists; a
 *       session-only debt resolves without authenticating at all;
 *   8.  an unverified logout lands as a session step in the debt (no secret
 *       material in debt or output), the cleanup-only retry resolves it
 *       without credentials, and a new state-changing run is then permitted.
 *
 * Run: node --test scripts/production-acceptance-idempotency.test.mjs
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
  DebtBlockedError,
  UsageError,
  newAcceptanceMarker,
  runAuthorizedAcceptance,
  runCleanupAcceptance,
} from "./production-acceptance-core.mjs";
import {
  readDebtRecord,
  writeDebtRecord,
} from "./acceptance-debt.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

const stackAvailable = dockerEngineAvailable()
  && existsSync(join(repoRoot, "php", "vendor", "autoload.php"))
  && existsSync(join(repoRoot, "contracts", "generated", "manifest.json"));

const marker = () => newAcceptanceMarker();

describe("ESZ-129 acceptance core (file 3/3) against the disposable full-stack fixture", {
  skip: !stackAvailable
    && "no Docker engine, PHP vendor or contract artifacts are available",
}, () => {
  let stack = null;
  let origin;
  let credentials;
  let debtDir;
  let own;
  let runCounter = 0;

  const customerEmail = () => `idem+${process.pid}-${runCounter++}@example.test`;

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
    debtDir = mkdtempSync(join(tmpdir(), "esz129-idem-debt-"));
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

  /** Captures stdout/stderr during one operation (no-secret proofs). */
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

  test("8. an unverified logout lands as a session step; cleanup resolves it without credentials; a new run is then permitted", async () => {
    // Booking cancelled cleanly by compensation, logout seam keeps the
    // session step live: the debt must carry exactly the session step.
    const captured = await captureOutput(() => run({
      marker: marker(),
      faults: {
        "fail-after-booking-create": "injected",
        "fail-compensation-logout": true,
      },
    }));
    const error = captured.outcome.ok ? null : captured.outcome.error;
    assert.ok(error, "the injected failure must reject the run");
    assert.equal(error.compensated, false);
    assert.ok(error.debtPath);
    const debt = readDebtRecord(origin, debtDir);
    assert.ok(debt);
    assert.equal(debt.steps.length, 1);
    assert.equal(debt.steps[0].kind, "session");
    assert.equal(debt.steps[0].attempted, "logout");
    assert.equal(debt.steps[0].status, "pending");
    for (const secret of [credentials.email, credentials.password]) {
      assert.equal(`${captured.stdout}${captured.stderr}`.includes(secret), false);
    }
    assert.doesNotMatch(JSON.stringify(debt), /@/);

    const cleanup = await runCleanupAcceptance({ origin, debtDir }); // session-only: no auth needed
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.debtRemoved, true);
    assert.equal(readDebtRecord(origin, debtDir), null);

    // A new state-changing run is permitted again and passes.
    const fresh = await run({ marker: marker() });
    assert.deepEqual(fresh.verifications, {
      mediaAbsent: true, bookingCancelled: true, sessionLoggedOut: true,
    });
  });

  test("7 + 7b. cleanup is idempotent, refuses without credentials and verifies before ever re-mutating", async () => {
    // One baseline full run whose media and booking end up clean.
    const baseline = await run({ marker: marker() });
    assert.equal(readDebtRecord(origin, debtDir), null);
    assert.equal(await bookingState(baseline.bookingReference), "cancelled");

    // A debt mixing every idempotent shape: a well-formed-but-nonexistent
    // media id, the already-cancelled baseline booking and two absent
    // bookings. Cleanup must verify first: nothing here may be re-mutated or
    // reported as an error.
    const crafted = {
      formatVersion: 1,
      origin,
      marker: baseline.marker,
      createdAt: new Date().toISOString(),
      steps: [
        { kind: "media", mediaId: "med_0000000000000000000000000000000f", attempted: "delete", status: "pending" },
        { kind: "booking", bookingReference: baseline.bookingReference, attempted: "cancel", status: "pending" },
        { kind: "booking", bookingReference: "bk_0000000000000000000000000000000e", attempted: "cancel", status: "pending" },
        { kind: "booking", bookingReference: "bk_0000000000000000000000000000000d", attempted: "cancel", status: "pending" },
      ],
    };
    writeDebtRecord(crafted, debtDir);

    // A debt with a booking step needs the admin surface: no credentials,
    // no HTTP — refused as usage, debt kept.
    await assert.rejects(
      () => runCleanupAcceptance({ origin, debtDir }),
      (error) => error instanceof UsageError && /admin surface/.test(error.message),
    );
    assert.equal(readDebtRecord(origin, debtDir).steps.length, 4);

    // While the debt exists, a new state-changing run is blocked before it
    // can create any mutation.
    const blocked = await run({ marker: marker() }).then(() => null, (failure) => failure);
    assert.ok(blocked instanceof DebtBlockedError, "a state-changing run must refuse while debt exists");

    const cleanup = await runCleanupAcceptance({
      origin,
      adminEmail: credentials.email,
      adminPassword: credentials.password,
      debtDir,
    });
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.debtRemoved, true);
    const media = cleanup.resolvedSteps.find((step) => step.kind === "media");
    assert.ok(media && media.clean);
    assert.match(media.detail, /already absent — verified clean/);
    const cancelled = cleanup.resolvedSteps.find((step) => step.ref === baseline.bookingReference);
    assert.ok(cancelled && cancelled.clean);
    assert.match(cancelled.detail, /already cancelled — verified clean/);
    for (const ref of ["bk_0000000000000000000000000000000d", "bk_0000000000000000000000000000000e"]) {
      const missing = cleanup.resolvedSteps.find((step) => step.ref === ref);
      assert.ok(missing && missing.clean, `${ref} must verify clean`);
      assert.match(missing.detail, /absent from the admin surface/);
    }
    assert.equal(readDebtRecord(origin, debtDir), null);
    // The baseline booking is untouched: still cancelled, never re-mutated.
    assert.equal(await bookingState(baseline.bookingReference), "cancelled");

    // A session-only debt resolves without authenticating at all.
    const sessionDebt = {
      formatVersion: 1,
      origin,
      marker: marker(),
      createdAt: new Date().toISOString(),
      steps: [{ kind: "session", attempted: "logout", status: "pending" }],
    };
    writeDebtRecord(sessionDebt, debtDir);
    const sessionCleanup = await runCleanupAcceptance({ origin, debtDir }); // no credentials at all
    assert.equal(sessionCleanup.ok, true);
    assert.equal(sessionCleanup.debtRemoved, true);
    assert.equal(readDebtRecord(origin, debtDir), null);
  });
});
