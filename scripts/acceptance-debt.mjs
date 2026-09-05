#!/usr/bin/env node
/**
 * ESZ-129 — the local cleanup-debt store for production acceptance.
 *
 * When a state-changing acceptance run cannot verify that everything it
 * created is gone, it persists a non-secret cleanup-debt record here, on the
 * operator's host. Every later state-changing run against the same origin is
 * refused until an explicit cleanup/resume run resolves the debt.
 *
 * What may be recorded (and nothing else): the target origin, the acceptance
 * marker, the opaque media id / booking reference of the resources that still
 * need cleanup, and the cleanup step/status. Admin/customer e-mail addresses,
 * passwords, cookies, CSRF tokens, message bodies and any other PII are never
 * written: the format below is structurally closed, and the write path
 * refuses a record that would smuggle such values in.
 *
 * Layout: one JSON file per origin under one debt directory (0700); each file
 * is written 0600 via a same-directory temp file + atomic rename, so a crash
 * can never leave a half-written record that a later run would silently
 * accept. The directory defaults to `~/.eszter/acceptance-debt`; the
 * ESZTER_ACCEPTANCE_DEBT_DIR environment variable relocates it (the tests
 * point it at a disposable scratch directory). Relocation moves the store —
 * it never disables the debt gate.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEBT_DIR_ENV = "ESZTER_ACCEPTANCE_DEBT_DIR";
export const DEBT_FORMAT_VERSION = 1;
export const DEBT_FILE_MODE = 0o600;
export const DEBT_DIR_MODE = 0o700;

const MEDIA_ID_PATTERN = /^med_[0-9a-f]{32}$/;
const BOOKING_REFERENCE_PATTERN = /^bk_[0-9a-f]{32}$/;

export class DebtFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "DebtFormatError";
    this.code = "DEBT_FORMAT";
  }
}

export class DebtExistsError extends Error {
  constructor(path) {
    super(`A cleanup-debt record already exists at ${path}; resolve it with the cleanup/resume mode before any new state-changing run.`);
    this.name = "DebtExistsError";
    this.code = "DEBT_EXISTS";
  }
}

/** The debt directory: the environment override, or ~/.eszter/acceptance-debt. */
export function debtDirFor(env = process.env) {
  return env[DEBT_DIR_ENV] ?? join(homedir(), ".eszter", "acceptance-debt");
}

function originKey(origin) {
  let normalized;
  try {
    normalized = new URL(origin).origin;
  } catch {
    throw new DebtFormatError(`Debt origin is not a URL origin: ${origin}`);
  }
  if (normalized !== origin) {
    throw new DebtFormatError(`Debt origin must be a normalized URL origin (got ${origin}, normalized ${normalized}).`);
  }
  return normalized;
}

/** One deterministic 0600 file per origin. */
export function debtFilePathFor(origin, debtDir) {
  const normalized = originKey(origin);
  const host = new URL(normalized).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return join(debtDir, `debt-${host}-${digest}.json`);
}

const STEP_KINDS = new Set(["media", "booking", "session"]);
const STEP_ATTEMPTS = new Set(["delete", "cancel", "logout"]);

/** Closed-form validation of one record. Throws DebtFormatError when invalid. */
export function validateDebtRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new DebtFormatError("Debt record must be an object.");
  }
  const allowedTop = new Set(["formatVersion", "origin", "marker", "createdAt", "steps"]);
  for (const key of Object.keys(record)) {
    if (!allowedTop.has(key)) throw new DebtFormatError(`Debt record carries a forbidden top-level field: ${key}`);
  }
  if (record.formatVersion !== DEBT_FORMAT_VERSION) {
    throw new DebtFormatError(`Debt record has an unknown formatVersion: ${record.formatVersion}`);
  }
  if (typeof record.origin !== "string") throw new DebtFormatError("Debt record carries no origin.");
  originKey(record.origin); // normalized https/http origin with no credentials/query/fragment
  if (new URL(record.origin).username || new URL(record.origin).password) {
    throw new DebtFormatError("Debt origin must not carry credentials.");
  }
  if (typeof record.marker !== "string" || record.marker === "") {
    throw new DebtFormatError("Debt record carries no acceptance marker.");
  }
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
    throw new DebtFormatError("Debt record carries no valid createdAt.");
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    throw new DebtFormatError("Debt record must carry at least one cleanup step.");
  }
  for (const [index, step] of record.steps.entries()) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new DebtFormatError(`Debt step ${index} is not an object.`);
    }
    const allowedStep = new Set(["kind", "status", "attempted", "mediaId", "bookingReference"]);
    for (const key of Object.keys(step)) {
      if (!allowedStep.has(key)) throw new DebtFormatError(`Debt step ${index} carries a forbidden field: ${key}`);
    }
    if (!STEP_KINDS.has(step.kind)) throw new DebtFormatError(`Debt step ${index} has an unknown kind: ${step.kind}`);
    if (step.status !== "pending") throw new DebtFormatError(`Debt step ${index} status must be "pending": ${step.status}`);
    if (!STEP_ATTEMPTS.has(step.attempted)) throw new DebtFormatError(`Debt step ${index} has an unknown attempted action: ${step.attempted}`);
    if (step.kind === "media") {
      if (typeof step.mediaId !== "string" || !MEDIA_ID_PATTERN.test(step.mediaId)) {
        throw new DebtFormatError(`Debt media step ${index} carries no valid opaque media id.`);
      }
      if (step.bookingReference !== undefined) throw new DebtFormatError(`Debt media step ${index} carries a booking reference.`);
    } else if (step.kind === "booking") {
      if (typeof step.bookingReference !== "string" || !BOOKING_REFERENCE_PATTERN.test(step.bookingReference)) {
        throw new DebtFormatError(`Debt booking step ${index} carries no valid opaque booking reference.`);
      }
      if (step.mediaId !== undefined) throw new DebtFormatError(`Debt booking step ${index} carries a media id.`);
    } else if (step.kind === "session") {
      if (step.mediaId !== undefined || step.bookingReference !== undefined) {
        throw new DebtFormatError(`Debt session step ${index} must not carry a resource reference.`);
      }
    }
  }
  return record;
}

/**
 * The no-secret audit: the serialized record must contain none of the values
 * a forbidden field would smuggle in. The structural allowlist above already
 * bounds the keys; this bounds the values — an e-mail or any other
 * personal/credential material would have to contain an `@`, and none of the
 * allowed values (normalized origin, ESZ marker, opaque ids, ISO timestamp,
 * fixed step vocabulary) ever does.
 */
export function auditDebtRecordForSecrets(record) {
  const serialized = JSON.stringify(record);
  if (/@/.test(serialized)) {
    throw new DebtFormatError("Debt record content matched the secret/PII audit (an '@' appears in a value).");
  }
  return record;
}

/** Reads the debt for one origin. Returns the record, or null when absent. */
export function readDebtRecord(origin, debtDir = debtDirFor()) {
  const path = debtFilePathFor(origin, debtDir);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DebtFormatError(
      `The cleanup-debt record at ${path} is unreadable (${error instanceof Error ? error.message : String(error)}). `,
    );
  }
  return validateDebtRecord(parsed);
}

/** Whether a valid (or at least present) debt exists for this origin. */
export function debtFileExists(origin, debtDir = debtDirFor()) {
  return existsSync(debtFilePathFor(origin, debtDir));
}

/**
 * Persists one debt record (0600, atomic). Refuses to overwrite an existing
 * record: the only way a record for an origin disappears is the cleanup mode
 * deleting it after verifying every recorded resource is clean.
 */
export function writeDebtRecord(record, debtDir = debtDirFor()) {
  const validated = auditDebtRecordForSecrets(validateDebtRecord(record));
  const path = debtFilePathFor(record.origin, debtDir);
  if (existsSync(path)) throw new DebtExistsError(path);
  mkdirSync(debtDir, { recursive: true, mode: DEBT_DIR_MODE });
  chmodSync(debtDir, DEBT_DIR_MODE);
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: DEBT_FILE_MODE });
  chmodSync(tempPath, DEBT_FILE_MODE);
  renameSync(tempPath, path);
  const mode = (statSync(path).mode & 0o777);
  if (mode !== DEBT_FILE_MODE) throw new Error(`Debt file mode is ${mode.toString(8)}, expected 600.`);
  return path;
}

/** Removes the debt record for one origin. Returns true when one existed. */
export function removeDebtRecord(origin, debtDir = debtDirFor()) {
  const path = debtFilePathFor(origin, debtDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
