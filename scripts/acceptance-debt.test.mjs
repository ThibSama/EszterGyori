#!/usr/bin/env node
/**
 * ESZ-129 — unit tests for the cleanup-debt store (`scripts/acceptance-debt.mjs`).
 *
 * Pure filesystem tests (no Docker, no PHP): record round-trip, 0600/0700
 * modes, per-origin isolation, refuse-overwrite, corruption handling and the
 * closed format / no-secret audits.
 *
 * Run: node --test scripts/acceptance-debt.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEBT_FILE_MODE,
  DebtExistsError,
  DebtFormatError,
  auditDebtRecordForSecrets,
  debtFilePathFor,
  debtDirFor,
  readDebtRecord,
  removeDebtRecord,
  validateDebtRecord,
  writeDebtRecord,
} from "./acceptance-debt.mjs";

function scratchDebtDir() {
  return mkdtempSync(join(tmpdir(), "esz129-debt-"));
}

const ORIGIN = "https://acceptance.example.com";
const MARKER = "ESZ-086-20260905083000-ab12cd34";

function sampleRecord(overrides = {}) {
  return {
    formatVersion: 1,
    origin: ORIGIN,
    marker: MARKER,
    createdAt: "2026-09-05T08:30:00.000Z",
    steps: [
      { kind: "media", mediaId: "med_00000000000000000000000000000000", attempted: "delete", status: "pending" },
      { kind: "booking", bookingReference: "bk_00000000000000000000000000000001", attempted: "cancel", status: "pending" },
    ],
    ...overrides,
  };
}

test("write/read round-trip with 0600 file and 0700 directory", () => {
  const dir = scratchDebtDir();
  const record = sampleRecord();
  const path = writeDebtRecord(record, dir);
  assert.ok(existsSync(path));
  assert.equal(statSync(path).mode & 0o777, DEBT_FILE_MODE);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readDebtRecord(ORIGIN, dir), record);
  // No temp files are left behind.
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
  // The stored JSON is exactly the validated record.
  assert.equal(JSON.parse(readFileSync(path, "utf8")).marker, MARKER);
});

test("records are keyed per origin and never overwritten", () => {
  const dir = scratchDebtDir();
  const first = writeDebtRecord(sampleRecord(), dir);
  // The same origin refuses a second record (only cleanup removes one).
  assert.throws(() => writeDebtRecord(sampleRecord(), dir), DebtExistsError);
  // A different origin has its own file and does not disturb the first.
  const second = writeDebtRecord(sampleRecord({ origin: "https://other.example.com" }), dir);
  assert.notEqual(second, first);
  assert.equal(readDebtRecord(ORIGIN, dir).marker, MARKER);
  assert.equal(readDebtRecord("https://other.example.com", dir).marker, MARKER);
});

test("remove deletes only the matching origin record", () => {
  const dir = scratchDebtDir();
  writeDebtRecord(sampleRecord(), dir);
  assert.equal(removeDebtRecord("https://other.example.com", dir), false);
  assert.equal(removeDebtRecord(ORIGIN, dir), true);
  assert.equal(readDebtRecord(ORIGIN, dir), null);
});

test("an unreadable or invalid debt record throws DebtFormatError (fail closed)", () => {
  const dir = scratchDebtDir();
  const path = debtFilePathFor(ORIGIN, dir);
  writeFileSync(path, "{not json", { mode: 0o600 });
  assert.throws(() => readDebtRecord(ORIGIN, dir), DebtFormatError);
  writeFileSync(path, JSON.stringify(sampleRecord({ formatVersion: 99 })), { mode: 0o600 });
  assert.throws(() => readDebtRecord(ORIGIN, dir), DebtFormatError);
  writeFileSync(path, JSON.stringify({ ...sampleRecord(), extra: "x" }), { mode: 0o600 });
  assert.throws(() => readDebtRecord(ORIGIN, dir), DebtFormatError);
});

test("the closed format refuses forbidden top-level and step fields", () => {
  assert.throws(() => validateDebtRecord(sampleRecord({ adminEmail: "a@b.c" })), DebtFormatError);
  assert.throws(() => validateDebtRecord(sampleRecord({ cookie: "eszter=abc" })), DebtFormatError);
  assert.throws(() => validateDebtRecord(sampleRecord({ password: "hunter2" })), DebtFormatError);
  const step = sampleRecord();
  step.steps[0].csrfToken = "zzz";
  assert.throws(() => validateDebtRecord(step), DebtFormatError);
  const step2 = sampleRecord();
  step2.steps[0].customerEmail = "customer@example.test";
  assert.throws(() => validateDebtRecord(step2), DebtFormatError);
});

test("the closed format refuses unknown kinds, invalid opaque ids and session refs", () => {
  const unknown = sampleRecord();
  unknown.steps[0].kind = "database";
  assert.throws(() => validateDebtRecord(unknown), DebtFormatError);
  const badMedia = sampleRecord();
  badMedia.steps[0].mediaId = "med_not-a-valid-id";
  assert.throws(() => validateDebtRecord(badMedia), DebtFormatError);
  const badBooking = sampleRecord();
  badBooking.steps[0] = { kind: "booking", bookingReference: "bk_short", attempted: "cancel", status: "pending" };
  assert.throws(() => validateDebtRecord(badBooking), DebtFormatError);
  const sessionWithRef = { ...sampleRecord({ steps: [{ kind: "session", attempted: "logout", status: "pending", bookingReference: "bk_00000000000000000000000000000001" }] }) };
  assert.throws(() => validateDebtRecord(sessionWithRef), DebtFormatError);
  const sessionOnly = { ...sampleRecord({ steps: [{ kind: "session", attempted: "logout", status: "pending" }] }) };
  assert.deepEqual(validateDebtRecord(sessionOnly).steps[0].kind, "session");
});

test("the no-secret audit refuses any record whose values could smuggle PII", () => {
  assert.throws(
    () => auditDebtRecordForSecrets(sampleRecord({ marker: "someone@example.test" })),
    DebtFormatError,
  );
  const step = sampleRecord();
  step.steps[0].mediaId = "med_0000000000000000000000000000000a"; // no '@' anywhere in allowed content
  assert.doesNotThrow(() => auditDebtRecordForSecrets(step));
  // The audit also protects the write path end to end.
  const dir = scratchDebtDir();
  assert.throws(
    () => writeDebtRecord(sampleRecord({ origin: "https://user:pass@host.example/" }), dir),
    DebtFormatError,
  );
});

test("debtDirFor honours the environment override and defaults under the home dir", () => {
  assert.equal(debtDirFor({ ESZTER_ACCEPTANCE_DEBT_DIR: "/tmp/x" }), "/tmp/x");
  assert.match(debtDirFor({}), /[\\/]\.eszter[\\/]acceptance-debt$/);
});

test("origin keys are normalized exactly", () => {
  const dir = scratchDebtDir();
  const record = sampleRecord();
  writeDebtRecord(record, dir);
  // Only the normalized URL-origin form is accepted as a key: the CLI passes
  // `new URL(...).origin`, so a trailing slash or a path would mean a
  // different key and is refused instead of silently normalizing.
  assert.equal(readDebtRecord(ORIGIN, dir).marker, MARKER);
  assert.throws(() => debtFilePathFor(`${ORIGIN}/`, dir), DebtFormatError);
  assert.throws(() => debtFilePathFor("https://host.example/path", dir), DebtFormatError);
  assert.throws(() => debtFilePathFor("not a url", dir), DebtFormatError);
});
