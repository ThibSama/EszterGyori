#!/usr/bin/env node
/**
 * ESZ-129 — the state-changing production-acceptance core.
 *
 * This module holds the authorized mutation acceptance, its immediate
 * resource tracking, its best-effort compensation and the unresolved-cleanup
 * debt lifecycle. It is deliberately free of CLI concerns (argument parsing,
 * HTTPS-origin enforcement, the live-confirmation phrase and environment
 * secret reading all stay in `production-acceptance.mjs`, so the CLI
 * authorization boundary is unchanged) — which is what lets the tests drive
 * this core directly against the disposable local full-stack fixture over a
 * plain HTTP loopback origin.
 *
 * ## The acceptance state machine
 *
 * Every resource/state transition is tracked the moment it exists:
 *   - the authenticated admin session (created by login);
 *   - the uploaded media asset (created by the upload);
 *   - the created booking (created by the public create).
 *
 * A tracked step is `live` from creation until its cleanup is *verified*
 * against authoritative state (admin media list / admin reference query /
 * protected probe), at which point it becomes `clean`:
 *   - media is deleted in the normal flow right after its upload and the
 *     deletion is verified against the admin media list;
 *   - the booking is cancelled through the admin surface — never deleted in
 *     the database — with its current `expectedUpdatedAt`
 *     optimistic-concurrency token (ESZ-139), freshly read from the admin
 *     reference query, then verified cancelled;
 *   - the session is logged out (server-side row destroyed) and verified by
 *     a protected probe that must answer 401.
 *
 * On any failure the runner compensates in the safe order the ticket fixes —
 * media first, then the booking, then the session — where every action is
 * verify-first and therefore idempotent: already-deleted media,
 * already-cancelled bookings and already-invalidated sessions verify clean
 * instead of failing again. The original failure always stays a failure: a
 * compensated run exits non-zero regardless of how clean the compensation
 * was.
 *
 * When compensation cannot verify a step, an unresolved-cleanup debt record
 * (scripts/acceptance-debt.mjs) is persisted and every later state-changing
 * run against the same origin is refused before it creates any new mutation,
 * until an explicit cleanup/resume run resolves it.
 *
 * ## Test-only fault seams
 *
 * Deterministic failure injection lives in the `faults` option and is never
 * read from the environment, so the public CLI can never activate it:
 *   - `"fail-after-media-upload"` — throw right after the media upload is
 *     verified and tracked, before its in-flow deletion;
 *   - `"fail-after-booking-create"` — throw right after the booking create is
 *     verified and tracked, before the admin query/mutations;
 *   - `"fail-compensation-cancel"` — the compensation's booking-cancel
 *     request throws once (the step stays live and lands in the debt);
 *   - `"fail-compensation-logout"` — the compensation's logout request throws
 *     once (the session step stays live and lands in the debt).
 */

import { probeReadiness, READINESS_COMPONENTS } from "./readiness.mjs";
import {
  debtFilePathFor,
  readDebtRecord,
  removeDebtRecord,
  writeDebtRecord,
} from "./acceptance-debt.mjs";

const MEDIA_ID_PATTERN = /^med_[0-9a-f]{32}$/;
// ESZ-161: the current XXXX-XXXX shape or a legacy bk_ reference.
const BOOKING_REFERENCE_PATTERN = /^(bk_[0-9a-f]{32}|[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})$/;
const PRIVACY_NOTICE_ID = "booking-privacy-v1";
const ADMIN_MEDIA_PATH = "/api/admin/media";

export class DebtBlockedError extends Error {
  constructor(record, path) {
    const kinds = record.steps.map((step) => step.kind).join(", ");
    super(
      `REFUSED: unresolved cleanup debt for ${record.origin} (acceptance marker ${record.marker}; ${record.steps.length} pending step(s): ${kinds}) exists at ${path}. `
      + "Resolve it with the cleanup/resume mode before any new state-changing run.",
    );
    this.name = "DebtBlockedError";
    this.code = "DEBT_BLOCKED";
    this.debtPath = path;
    this.marker = record.marker;
    this.pendingSteps = record.steps;
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.code = "USAGE";
  }
}

/** The run failed; `message` is the original failure, outcome attached. */
export class AcceptanceRunError extends Error {
  constructor(message, { cause, compensated, debtPath, compensationSteps } = {}) {
    super(message);
    this.name = "AcceptanceRunError";
    this.code = "ACCEPTANCE_RUN_FAILED";
    if (cause !== undefined) this.cause = cause;
    this.compensated = compensated;
    this.debtPath = debtPath ?? null;
    this.compensationSteps = compensationSteps ?? [];
  }
}

function dateInParis(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

/** One acceptance marker, unique per run. */
export function newAcceptanceMarker(now = new Date()) {
  return `ESZ-086-${now.toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * The HTTP client of one acceptance run: per-run cookie jar and CSRF token,
 * so several runs (or a run and a cleanup) can share one process.
 */
class AcceptanceClient {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
    this.csrfToken = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  rememberCookies(headers) {
    for (const value of headers.getSetCookie?.() ?? []) {
      const [pair] = value.split(";", 1);
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue === "" || /max-age=0/i.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, cookieValue);
    }
  }

  /**
   * One HTTP call. Never throws on an HTTP status — the caller asserts on the
   * returned {status, body, text} — so compensation can treat statuses such
   * as 404/409/401 as facts instead of as crashes. Network/transport failures
   * throw with the method and path in the message.
   */
  async call(path, { method = "GET", body, form, headers = {}, csrf = false } = {}) {
    const requestHeaders = { accept: "application/json", ...headers };
    if (this.cookies.size) requestHeaders.cookie = this.cookieHeader();
    if (csrf) {
      if (!this.csrfToken) throw new Error(`No CSRF token is available for ${method} ${path}.`);
      requestHeaders["x-csrf-token"] = this.csrfToken;
    }
    let payload;
    if (form !== undefined) {
      payload = form;
    } else if (body !== undefined) {
      requestHeaders["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(new URL(path, this.origin), {
        method,
        headers: requestHeaders,
        body: payload,
        redirect: "manual",
      });
    } catch (error) {
      throw new Error(`${method} ${path} failed (${error instanceof Error ? error.message : String(error)})`);
    }
    this.rememberCookies(response.headers);
    const text = await response.text();
    let parsed = null;
    if (text && response.headers.get("content-type")?.includes("application/json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${path} returned malformed JSON.`);
      }
    }
    return { status: response.status, body: parsed, text };
  }
}

/** One tracked resource/state transition of a run. */
class TrackedStep {
  constructor(kind, ref, attempted) {
    this.kind = kind; // "media" | "booking" | "session"
    this.ref = ref; // opaque id/reference; null for the session step
    this.attempted = attempted; // "delete" | "cancel" | "logout"
    this.live = true; // false once cleanup is VERIFIED
  }
}

/** Verify media absence through the authoritative admin media library. */
async function mediaAbsent(client, mediaId) {
  const list = await client.call(ADMIN_MEDIA_PATH);
  if (list.status !== 200) {
    throw new Error(`GET ${ADMIN_MEDIA_PATH} answered HTTP ${list.status} while verifying media absence.`);
  }
  const assets = Array.isArray(list.body?.assets) ? list.body.assets : [];
  return !assets.some((asset) => asset?.id === mediaId);
}

/**
 * Compensation action: media. Verify-first — an already-deleted asset is
 * clean, not an error (idempotent cleanup).
 */
async function compensateMedia(client, step) {
  const mediaId = step.ref;
  try {
    if (await mediaAbsent(client, mediaId)) {
      return { clean: true, detail: `media ${mediaId} already absent — verified clean` };
    }
    const deleted = await client.call(ADMIN_MEDIA_PATH, {
      method: "DELETE", csrf: true, body: { id: mediaId },
    });
    if (deleted.status === 204 || deleted.status === 404) {
      if (await mediaAbsent(client, mediaId)) {
        return { clean: true, detail: `media ${mediaId} deleted (${deleted.status}) and verified absent` };
      }
      return { clean: false, detail: `media ${mediaId} delete answered ${deleted.status} but the asset is still listed` };
    }
    // A 5xx could still have removed the asset server-side: re-verify before
    // declaring the step unclean.
    if (deleted.status >= 500 && (await mediaAbsent(client, mediaId))) {
      return { clean: true, detail: `media ${mediaId} delete answered ${deleted.status} but the asset is absent — verified clean` };
    }
    return { clean: false, detail: `media ${mediaId} delete answered HTTP ${deleted.status}` };
  } catch (error) {
    // A transport failure could hide a successful deletion: the authoritative
    // re-query is the only trustworthy verdict.
    try {
      if (await mediaAbsent(client, mediaId)) {
        return { clean: true, detail: `media ${mediaId} transport failure; authoritative re-query shows the asset absent — verified clean` };
      }
    } catch {
      // fall through to the unclean verdict
    }
    return { clean: false, detail: `media ${mediaId} cleanup failed (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Reads the booking's current authoritative state and concurrency token.
 * Returns {found:false} on 404 (the booking does not exist — the application
 * never deletes rows, so a 404 means there is nothing left to cancel).
 */
async function queryBooking(client, reference) {
  const query = await client.call("/api/admin/bookings/query", {
    method: "POST", body: { mode: "reference", reference },
  });
  if (query.status === 404) return { found: false };
  if (query.status !== 200) {
    throw new Error(`reference query for ${reference} answered HTTP ${query.status}.`);
  }
  const booking = query.body?.booking ?? null;
  if (booking === null || typeof booking !== "object") {
    throw new Error(`reference query for ${reference} returned no booking envelope.`);
  }
  if (booking.reference !== reference || typeof booking.updatedAt !== "string") {
    throw new Error(`reference query for ${reference} returned no current concurrency token.`);
  }
  return { found: true, booking };
}

/** One cancel attempt through the admin surface with an explicit token. */
async function cancelBooking(client, reference, expectedUpdatedAt) {
  return client.call("/api/admin/bookings", {
    method: "PATCH", csrf: true,
    body: {
      action: "cancel", reference, expectedUpdatedAt,
      reason: "acceptance cleanup — cancelled after an interrupted run",
    },
  });
}

/**
 * Compensation action: booking. Cancels a still-confirmed booking with a
 * freshly queried `expectedUpdatedAt` (a stale token would answer 409 and
 * write nothing); a booking already cancelled — or gone — verifies clean.
 */
async function compensateBooking(client, step, { faults = {}, consumed = {} } = {}) {
  const reference = step.ref;
  try {
    const current = await queryBooking(client, reference);
    if (!current.found) {
      return { clean: true, detail: `booking ${reference} absent from the admin surface — nothing to cancel` };
    }
    if (current.booking.state === "cancelled") {
      return { clean: true, detail: `booking ${reference} already cancelled — verified clean` };
    }
    if (current.booking.state !== "confirmed") {
      return { clean: false, detail: `booking ${reference} is in unexpected state ${current.booking.state}` };
    }
    if (faults["fail-compensation-cancel"] && !consumed["fail-compensation-cancel"]) {
      consumed["fail-compensation-cancel"] = true;
      throw new Error("injected fault: compensation booking-cancel fails once (test seam)");
    }
    const cancelled = await cancelBooking(client, reference, current.booking.updatedAt);
    if (cancelled.status === 200 && cancelled.body?.booking?.state === "cancelled") {
      const after = await queryBooking(client, reference);
      if (after.found && after.booking.state === "cancelled") {
        return { clean: true, detail: `booking ${reference} cancelled (200) with its current token and verified cancelled` };
      }
      return { clean: false, detail: `booking ${reference} cancel answered 200 but the re-query does not show it cancelled` };
    }
    if (cancelled.status === 409) {
      // The token went stale between the query and the cancel (another admin
      // action landed). Re-query: if the booking is now cancelled it is clean;
      // otherwise retry once with the newest token.
      const retried = await queryBooking(client, reference);
      if (retried.found && retried.booking.state === "cancelled") {
        return { clean: true, detail: `booking ${reference} 409 REVISION_CONFLICT; re-query shows it cancelled — verified clean` };
      }
      if (retried.found && retried.booking.state === "confirmed") {
        const retry = await cancelBooking(client, reference, retried.booking.updatedAt);
        if (retry.status === 200 && retry.body?.booking?.state === "cancelled") {
          return { clean: true, detail: `booking ${reference} cancelled after a 409 retry with the newest token` };
        }
      }
      return { clean: false, detail: `booking ${reference} cancel answered 409 REVISION_CONFLICT and the retry did not cancel it` };
    }
    if (cancelled.status >= 500) {
      // A 5xx could still have cancelled server-side: verify before failing.
      const after = await queryBooking(client, reference);
      if (after.found && after.booking.state === "cancelled") {
        return { clean: true, detail: `booking ${reference} cancel answered ${cancelled.status} but the re-query shows it cancelled — verified clean` };
      }
    }
    return { clean: false, detail: `booking ${reference} cancel answered HTTP ${cancelled.status}` };
  } catch (error) {
    try {
      const after = await queryBooking(client, reference);
      if (after.found && after.booking.state === "cancelled") {
        return { clean: true, detail: `booking ${reference} transport failure; re-query shows it cancelled — verified clean` };
      }
    } catch {
      // fall through to the unclean verdict
    }
    return { clean: false, detail: `booking ${reference} cleanup failed (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Compensation action: session. Logs out (destroying the server-side row)
 * when the run still holds a live session; a logout that answers 401 means
 * the session was already invalid and verifies clean through the protected
 * probe. The protected probe is the authoritative verification: it must
 * answer 401 without a session.
 */
async function compensateSession(client, _step, { faults = {}, consumed = {} } = {}) {
  const probe = async () => {
    const reply = await client.call(ADMIN_MEDIA_PATH); // no cookie: must be refused
    return reply.status === 401;
  };
  try {
    if (faults["fail-compensation-logout"] && !consumed["fail-compensation-logout"]) {
      consumed["fail-compensation-logout"] = true;
      throw new Error("injected fault: compensation logout fails once (test seam)");
    }
    const logout = await client.call("/api/auth/logout", { method: "POST", csrf: true });
    if (logout.status === 204 || logout.status === 401) {
      if (await probe()) {
        return { clean: true, detail: `logout answered ${logout.status}; the protected probe answers 401 — session revoked` };
      }
      return { clean: false, detail: `logout answered ${logout.status} but the protected probe did not answer 401` };
    }
    return { clean: false, detail: `logout answered HTTP ${logout.status}` };
  } catch (error) {
    // A transport failure (or the injected seam) could hide a completed
    // logout: the protected probe is the only trustworthy verdict.
    if (await probe().catch(() => false)) {
      return { clean: true, detail: "logout failure; the protected probe answers 401 — session revoked" };
    }
    return { clean: false, detail: `session logout failed (${error instanceof Error ? error.message : String(error)})` };
  }
}

function compensationForStep(step) {
  if (step.kind === "media") return compensateMedia;
  if (step.kind === "booking") return compensateBooking;
  return compensateSession;
}

/** Builds the non-secret debt record from the still-live steps. */
function debtRecordFor(origin, marker, liveSteps) {
  const steps = liveSteps.map((step) => {
    if (step.kind === "media") return { kind: "media", mediaId: step.ref, attempted: "delete", status: "pending" };
    if (step.kind === "booking") return { kind: "booking", bookingReference: step.ref, attempted: "cancel", status: "pending" };
    return { kind: "session", attempted: "logout", status: "pending" };
  });
  return {
    formatVersion: 1,
    origin,
    marker,
    createdAt: new Date().toISOString(),
    steps,
  };
}

/**
 * Probes readiness and prints the READINESS lines (the same read-only probe
 * the CLI's read-only mode runs — reused, never duplicated). Throws when the
 * origin is not ready, before any mutation is attempted.
 */
async function probeAndReportReadiness(origin) {
  const verdict = await probeReadiness(origin);
  for (const name of READINESS_COMPONENTS) {
    const component = verdict.components[name];
    const detail = component.passed ? "PASS" : `FAIL — ${component.reason}`;
    process.stdout.write(`READINESS ${name}: ${detail}\n`);
  }
  if (!verdict.ready) {
    const summary = verdict.failures
      .map((name) => `${name}: ${verdict.components[name].reason}`)
      .join("; ");
    throw new Error(`readiness probe FAILED — ${summary}`);
  }
}

/**
 * The authorized mutation acceptance. The caller (the CLI, or a test against
 * the disposable fixture) has already resolved the origin and holds the live
 * authorization; this function itself performs the debt gate — a later
 * state-changing run refuses to create any new mutation while unresolved debt
 * exists — then the readiness probe, then the tracked flow.
 *
 * @param {object} options
 * @param {string} options.origin Normalized origin (https for the CLI; the
 *   tests use the disposable stack's http://127.0.0.1:<port> origin).
 * @param {string} options.adminEmail
 * @param {string} options.adminPassword
 * @param {string} options.customerEmail
 * @param {string} [options.marker]
 * @param {string} [options.debtDir]
 * @param {Record<string, unknown>} [options.faults] test-only fault seams
 * @returns {Promise<{marker: string, mediaId: string, bookingReference: string,
 *   verifications: {mediaAbsent: boolean, bookingCancelled: boolean,
 *   sessionLoggedOut: boolean}}>}
 */
export async function runAuthorizedAcceptance({
  origin,
  adminEmail,
  adminPassword,
  customerEmail,
  marker = newAcceptanceMarker(),
  debtDir,
  faults = {},
} = {}) {
  // 1. Debt gate: refuse before creating any new mutation (no session, no
  // upload, no booking) while an unresolved debt exists for this origin.
  const existing = readDebtRecord(origin, debtDir);
  if (existing !== null) {
    throw new DebtBlockedError(existing, debtFilePathFor(origin, debtDir));
  }

  if (!adminEmail || !adminPassword || !customerEmail) {
    throw new UsageError(
      "State-changing acceptance requires ESZTER_ACCEPTANCE_ADMIN_EMAIL, ESZTER_ACCEPTANCE_ADMIN_PASSWORD and ESZTER_ACCEPTANCE_CUSTOMER_EMAIL.",
    );
  }

  const client = new AcceptanceClient(origin);
  const steps = [];
  const consumed = {};
  let sessionStep = null;

  const track = (kind, ref, attempted) => {
    const step = new TrackedStep(kind, ref, attempted);
    steps.push(step);
    if (kind === "session") sessionStep = step;
    return step;
  };

  // 2. Readiness (read-only) before any mutation.
  await probeAndReportReadiness(origin);

  try {
    // 3. Anonymous CSRF bootstrap, then the authenticated acceptance session.
    const session = await client.call("/api/auth/session");
    if (session.status !== 200 || session.body?.csrfToken === undefined) {
      throw new Error(`GET /api/auth/session returned no CSRF token (HTTP ${session.status}).`);
    }
    client.csrfToken = session.body.csrfToken;
    const login = await client.call("/api/auth/login", {
      method: "POST", csrf: true, body: { email: adminEmail, password: adminPassword },
    });
    if (login.status !== 200 || login.body?.authenticated !== true) {
      throw new Error(`Admin login did not produce an authenticated session (HTTP ${login.status}).`);
    }
    client.csrfToken = login.body.csrfToken;
    track("session", null, "logout");
    process.stdout.write("PASS admin login (authenticated session created and tracked)\n");

    // 4. Media: upload a marker-named PNG, assert its id, delete it, verify
    // the asset is absent from the admin media library.
    // A real gd-verifiable PNG (8x8 RGB). ESZ-135's ingest refuses files the
    // image pipeline cannot re-encode, so the tiny palette PNG once embedded
    // here no longer passes — this one is accepted and re-encoded cleanly.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAFElEQVQImWM8IafBgA0wYRUdtBIA2HwBHp3chkUAAAAASUVORK5CYII=",
      "base64",
    );
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), `${marker}.png`);
    const upload = await client.call(ADMIN_MEDIA_PATH, { method: "POST", csrf: true, form });
    if (upload.status !== 201) {
      throw new Error(`POST ${ADMIN_MEDIA_PATH} expected 201, got ${upload.status}.`);
    }
    const mediaId = upload.body?.asset?.id;
    if (typeof mediaId !== "string" || !MEDIA_ID_PATTERN.test(mediaId)) {
      throw new Error("Media upload returned no valid id.");
    }
    const mediaStep = track("media", mediaId, "delete");
    process.stdout.write(`PASS media upload (${mediaId}, tracked)\n`);
    if (faults["fail-after-media-upload"]) {
      throw new Error(`injected fault: ${faults["fail-after-media-upload"]}`);
    }
    const deleted = await client.call(ADMIN_MEDIA_PATH, {
      method: "DELETE", csrf: true, body: { id: mediaId },
    });
    if (deleted.status !== 204 && deleted.status !== 404) {
      throw new Error(`DELETE ${ADMIN_MEDIA_PATH} expected 204, got ${deleted.status}.`);
    }
    if (!(await mediaAbsent(client, mediaId))) {
      throw new Error(`Media ${mediaId} is still listed after its deletion.`);
    }
    mediaStep.live = false;
    process.stdout.write(`PASS media deletion verified absent (${mediaId})\n`);

    // 5. Services and authoritative availability. The documented acceptance
    // horizon is days 2-60, but the slot engine answers at most its bounded
    // result count (booking-domain `availability.limits.maxResults`) and
    // refuses an over-full window — so the window is walked in bounded
    // sub-windows (each far under the result cap on the densest grid) and the
    // first free slot found is the first free slot of the whole horizon.
    const services = await client.call("/api/booking/services");
    if (services.status !== 200) throw new Error(`GET /api/booking/services answered HTTP ${services.status}.`);
    const service = services.body?.services?.[0];
    if (!service?.key) throw new Error("No active booking service is available for acceptance.");
    let slot = null;
    for (const [fromDay, untilDay] of [[2, 21], [22, 41], [42, 60]]) {
      const availability = await client.call("/api/booking/availability", {
        method: "POST",
        body: { serviceKey: service.key, fromDate: dateInParis(fromDay), untilDate: dateInParis(untilDay) },
      });
      if (availability.status !== 200) {
        throw new Error(`Availability for days ${fromDay}-${untilDay} answered HTTP ${availability.status}.`);
      }
      const windowSlots = availability.body?.slots;
      if (Array.isArray(windowSlots) && windowSlots.length > 0) {
        slot = windowSlots[0];
        break;
      }
    }
    if (!slot?.startsAtUtc) {
      throw new Error("No valid slot is available in the next 60 days; no booking was created.");
    }

    // 6. Booking creation (public surface; tracked immediately).
    const created = await client.call("/api/bookings", {
      method: "POST",
      body: {
        serviceKey: service.key,
        startsAtUtc: slot.startsAtUtc,
        customerName: marker,
        customerEmail,
        customerPhone: null,
        customerNote: `${marker} isolated production acceptance; cancel after verification`,
        // ESZ-161: the catalog's current privacy notice id; no consent field.
        privacyNoticeId: PRIVACY_NOTICE_ID,
      },
    });
    if (created.status !== 201) throw new Error(`Booking creation expected 201, got ${created.status}.`);
    const bookingReference = created.body?.reference;
    if (typeof bookingReference !== "string" || !BOOKING_REFERENCE_PATTERN.test(bookingReference)) {
      throw new Error("Booking creation returned no valid reference.");
    }
    const bookingStep = track("booking", bookingReference, "cancel");
    process.stdout.write(`PASS booking created (${bookingReference}, tracked)\n`);
    if (faults["fail-after-booking-create"]) {
      throw new Error(`injected fault: ${faults["fail-after-booking-create"]}`);
    }

    // 7. Admin update with the booking's current optimistic-concurrency
    // token, read from the ESZ-145 reference query.
    const queried = await queryBooking(client, bookingReference);
    if (!queried.found || queried.booking.state !== "confirmed") {
      throw new Error("The acceptance booking is absent from the admin query surface or not confirmed.");
    }
    const update = await client.call("/api/admin/bookings", {
      method: "PATCH", csrf: true,
      body: {
        action: "update", reference: bookingReference,
        expectedUpdatedAt: queried.booking.updatedAt,
        customerName: queried.booking.customerName,
        customerEmail: queried.booking.customerEmail,
        customerPhone: queried.booking.customerPhone,
        customerNote: `${marker} admin mutation verified`,
      },
    });
    if (update.status !== 200 || update.body?.booking?.reference !== bookingReference) {
      throw new Error(`Admin update expected 200, got ${update.status}.`);
    }
    process.stdout.write("PASS admin update carried the current expectedUpdatedAt\n");

    // 8. Cancel through the admin surface with a freshly read token (the
    // update advanced updatedAt, so the previous token is stale by design).
    const fresh = await queryBooking(client, bookingReference);
    if (!fresh.found || fresh.booking.state !== "confirmed" || fresh.booking.updatedAt === queried.booking.updatedAt) {
      throw new Error("The reference query did not return a fresh concurrency token after the update.");
    }
    const cancelled = await cancelBooking(client, bookingReference, fresh.booking.updatedAt);
    if (cancelled.status !== 200 || cancelled.body?.booking?.state !== "cancelled") {
      throw new Error(`Admin cancel expected 200 with a cancelled booking, got ${cancelled.status}.`);
    }
    bookingStep.live = false;
    process.stdout.write(`PASS booking cancelled through the admin surface (${bookingReference})\n`);

    // 9. Normal-success verification: media absent, booking cancelled,
    // session logged out and refused by the protected surface.
    if (!(await mediaAbsent(client, mediaId))) {
      throw new Error(`Media ${mediaId} is present at the end of a successful acceptance run.`);
    }
    const finalQuery = await queryBooking(client, bookingReference);
    if (!finalQuery.found || finalQuery.booking.state !== "cancelled") {
      throw new Error(`Booking ${bookingReference} is not cancelled at the end of a successful acceptance run.`);
    }
    const logout = await client.call("/api/auth/logout", { method: "POST", csrf: true });
    if (logout.status !== 204) throw new Error(`Logout expected 204, got ${logout.status}.`);
    sessionStep.live = false;
    const probe = await client.call(ADMIN_MEDIA_PATH);
    if (probe.status !== 401) {
      throw new Error(`The admin surface answered ${probe.status} after logout; the session is not invalidated.`);
    }

    process.stdout.write(`\nHTTP acceptance completed for ${marker}.\n`);
    process.stdout.write(`Booking ${bookingReference} is cancelled; uploaded media was deleted and verified absent; the acceptance session is revoked.\n`);
    return {
      marker,
      mediaId,
      bookingReference,
      verifications: { mediaAbsent: true, bookingCancelled: true, sessionLoggedOut: true },
    };
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(`\nFAIL ${original.message}\n`);

    // Best-effort compensation in the ticket's safe order: media, then the
    // booking, then the session. Each action is independent and idempotent;
    // a failing step never stops the ones after it.
    const compensationSteps = [];
    const compensate = async (step, fn) => {
      const outcome = await fn(client, step, { faults, consumed }).catch(
        (failure) => ({ clean: false, detail: failure instanceof Error ? failure.message : String(failure) }),
      );
      if (outcome.clean) step.live = false;
      process.stdout.write(`COMPENSATE ${step.kind} ${step.ref ?? "(session)"}: ${outcome.detail}\n`);
      compensationSteps.push({ kind: step.kind, ref: step.ref, ...outcome });
    };
    for (const kind of ["media", "booking"]) {
      for (const step of steps.filter((candidate) => candidate.kind === kind && candidate.live)) {
        await compensate(step, compensationForStep(step));
      }
    }
    if (sessionStep !== null && sessionStep.live) {
      await compensate(sessionStep, compensateSession);
    }

    const stillLive = steps.filter((step) => step.live);
    const compensated = stillLive.length === 0;
    let debtPath = null;
    if (!compensated) {
      const record = debtRecordFor(origin, marker, stillLive);
      debtPath = writeDebtRecord(record, debtDir);
      process.stderr.write(
        `CLEANUP DEBT: automatic cleanup is incomplete (${stillLive.map((step) => step.kind).join(", ")}); `
        + `non-secret cleanup-debt record written to ${debtPath} (0600). Resolve it with the cleanup/resume mode.\n`,
      );
    }
    throw new AcceptanceRunError(original.message, {
      cause: original,
      compensated,
      debtPath,
      compensationSteps,
    });
  }
}

/**
 * The explicit cleanup/resume mode. Loads the debt for the origin,
 * authenticates only when a recorded step needs the admin surface, retries
 * the safe cleanup with authoritative re-queries, and removes the debt record
 * only after every recorded resource is verified clean.
 *
 * @param {object} options
 * @param {string} options.origin
 * @param {string} [options.adminEmail] required only when media/booking steps exist
 * @param {string} [options.adminPassword] required only when media/booking steps exist
 * @param {string} [options.debtDir]
 * @returns {Promise<{ok: boolean, nothingToDo?: boolean, resolvedSteps: Array<object>,
 *   debtRemoved: boolean}>}
 */
export async function runCleanupAcceptance({
  origin,
  adminEmail,
  adminPassword,
  debtDir,
} = {}) {
  const debt = readDebtRecord(origin, debtDir); // a corrupt record throws: no run proceeds
  if (debt === null) {
    process.stdout.write(`No unresolved cleanup debt for ${origin}.\n`);
    return { ok: true, nothingToDo: true, resolvedSteps: [], debtRemoved: false };
  }

  const needsAuth = debt.steps.some((step) => step.kind === "media" || step.kind === "booking");
  const client = new AcceptanceClient(origin);
  const resolvedSteps = [];
  let loginStep = null;

  const finishSession = async () => {
    if (!loginStep) return;
    const outcome = await compensateSession(client).catch(
      (failure) => ({ clean: false, detail: failure instanceof Error ? failure.message : String(failure) }),
    );
    if (outcome.clean) {
      loginStep.live = false;
      process.stdout.write(`CLEAN session (cleanup run's own session): ${outcome.detail}\n`);
    } else {
      process.stderr.write(`WARNING cleanup session logout unverified: ${outcome.detail}\n`);
    }
  };

  try {
    if (needsAuth) {
      if (!adminEmail || !adminPassword) {
        throw new UsageError(
          "This cleanup debt needs the admin surface; set ESZTER_ACCEPTANCE_ADMIN_EMAIL and ESZTER_ACCEPTANCE_ADMIN_PASSWORD in the environment.",
        );
      }
      const session = await client.call("/api/auth/session");
      if (session.status !== 200 || session.body?.csrfToken === undefined) {
        throw new Error(`GET /api/auth/session returned no CSRF token (HTTP ${session.status}).`);
      }
      client.csrfToken = session.body.csrfToken;
      const login = await client.call("/api/auth/login", {
        method: "POST", csrf: true, body: { email: adminEmail, password: adminPassword },
      });
      if (login.status !== 200 || login.body?.authenticated !== true) {
        throw new Error(`Cleanup login failed (HTTP ${login.status}); the debt is kept.`);
      }
      client.csrfToken = login.body.csrfToken;
      loginStep = new TrackedStep("session", null, "logout");
      process.stdout.write("PASS cleanup admin login (authenticated only because the debt needs the admin surface)\n");
    }

    let allClean = true;
    for (const recorded of debt.steps) {
      if (recorded.kind === "media") {
        const step = new TrackedStep("media", recorded.mediaId, "delete");
        const outcome = await compensateMedia(client, step);
        if (outcome.clean) {
          process.stdout.write(`CLEAN media ${recorded.mediaId}: ${outcome.detail}\n`);
        } else {
          allClean = false;
          process.stderr.write(`UNCLEAN media ${recorded.mediaId}: ${outcome.detail}\n`);
        }
        resolvedSteps.push({ kind: "media", ref: recorded.mediaId, clean: outcome.clean, detail: outcome.detail });
      } else if (recorded.kind === "booking") {
        const step = new TrackedStep("booking", recorded.bookingReference, "cancel");
        const outcome = await compensateBooking(client, step);
        if (outcome.clean) {
          process.stdout.write(`CLEAN booking ${recorded.bookingReference}: ${outcome.detail}\n`);
        } else {
          allClean = false;
          process.stderr.write(`UNCLEAN booking ${recorded.bookingReference}: ${outcome.detail}\n`);
        }
        resolvedSteps.push({ kind: "booking", ref: recorded.bookingReference, clean: outcome.clean, detail: outcome.detail });
      } else {
        // Session step: the acceptance session's cookie is never persisted
        // (the debt format forbids it), so no public endpoint can address the
        // server-side row without it. The row is bounded by the application's
        // absolute session lifetime and removed by its own bounded GC sweep;
        // the local audit — the closed, secret-free debt format validated
        // again on load — is the verification this mode can perform.
        const detail = "acceptance session cookie never persisted; server-side row bounded by the absolute session lifetime and swept by the application GC — no usable acceptance session remains";
        process.stdout.write(`CLEAN session: ${detail}\n`);
        resolvedSteps.push({ kind: "session", ref: null, clean: true, detail });
      }
    }

    if (allClean) {
      removeDebtRecord(origin, debtDir);
      process.stdout.write(`Cleanup debt for ${origin} resolved and removed.\n`);
      return { ok: true, resolvedSteps, debtRemoved: true };
    }
    process.stderr.write(`Cleanup debt for ${origin} is kept; unresolved steps remain.\n`);
    return { ok: false, resolvedSteps, debtRemoved: false };
  } finally {
    await finishSession();
  }
}
