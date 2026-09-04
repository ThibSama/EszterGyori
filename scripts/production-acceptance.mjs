#!/usr/bin/env node

import { probeReadiness, READINESS_COMPONENTS } from "./readiness.mjs";

const LIVE_CONFIRMATION = "I_AUTHORIZE_ESZTER_LIVE_MUTATIONS";
const args = new Map(process.argv.slice(2).map((argument) => {
  const match = argument.match(/^--([^=]+)(?:=(.*))?$/);
  if (!match) throw new Error(`Unknown argument: ${argument}`);
  return [match[1], match[2] ?? true];
}));

if (args.has("help")) {
  process.stdout.write(`Usage:
  ESZTER_ACCEPTANCE_TARGET_URL=https://… npm run acceptance:production
  ESZTER_ACCEPTANCE_TARGET_URL=https://… ESZTER_ACCEPTANCE_ADMIN_EMAIL=… \\
    ESZTER_ACCEPTANCE_ADMIN_PASSWORD=… ESZTER_ACCEPTANCE_CUSTOMER_EMAIL=… \\
    npm run acceptance:production -- --live-confirmation=${LIVE_CONFIRMATION}

Without the exact confirmation value, only read-only checks run. Secrets are read
from the environment so they do not enter shell history or process arguments.
`);
  process.exit(0);
}

const targetValue = process.env.ESZTER_ACCEPTANCE_TARGET_URL;
if (!targetValue) throw new Error("ESZTER_ACCEPTANCE_TARGET_URL is required.");
const target = new URL(targetValue);
if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) {
  throw new Error("The target must be an explicit HTTPS origin with no credentials, query or fragment.");
}
if (target.pathname !== "/") throw new Error("The target must be an origin URL ending at `/`.");

const confirmed = args.get("live-confirmation") === LIVE_CONFIRMATION;
const marker = `ESZ-086-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
const cookies = new Map();
let csrfToken = null;
let mediaId = null;
let bookingReference = null;
let bookingCancelled = false;

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function rememberCookies(headers) {
  for (const value of headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";", 1);
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (cookieValue === "" || /max-age=0/i.test(value)) cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

async function request(path, { method = "GET", body, headers = {}, csrf = false, expected = [200] } = {}) {
  const requestHeaders = { accept: "application/json", ...headers };
  if (cookies.size) requestHeaders.cookie = cookieHeader();
  if (csrf) {
    if (!csrfToken) throw new Error(`No CSRF token is available for ${method} ${path}.`);
    requestHeaders["x-csrf-token"] = csrfToken;
  }
  if (body !== undefined && !(body instanceof FormData)) requestHeaders["content-type"] = "application/json";
  const response = await fetch(new URL(path, target), {
    method,
    headers: requestHeaders,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  rememberCookies(response.headers);
  const text = await response.text();
  let parsed = null;
  if (text && response.headers.get("content-type")?.includes("application/json")) {
    try { parsed = JSON.parse(text); } catch { throw new Error(`${method} ${path} returned malformed JSON.`); }
  }
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path}: expected ${expected.join("/")}, got ${response.status}: ${text.slice(0, 300)}`);
  }
  process.stdout.write(`PASS ${method} ${path} (${response.status})\n`);
  return { response, body: parsed, text };
}

function dateInParis(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

/**
 * Read-only mode = the project readiness probe (ESZ-127/AUD-22).
 *
 * Health alone is liveness, so it is not enough: readiness must also prove the
 * exported public page, the published `/api/content` envelope and that
 * `/api/booking/services` reaches the real booking/MySQL surface with at least
 * one active bookable service. Those are exactly the checks
 * `scripts/readiness.mjs` runs — reused here rather than duplicated, so the
 * deployed-origin answer and the local one come from the same code. The probe
 * is read-only by construction: no session, no upload, no booking, no cron,
 * no SMTP contact.
 */
async function readOnlyChecks() {
  const verdict = await probeReadiness(target.origin);
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

async function fullAcceptance() {
  const email = process.env.ESZTER_ACCEPTANCE_ADMIN_EMAIL;
  const password = process.env.ESZTER_ACCEPTANCE_ADMIN_PASSWORD;
  const customerEmail = process.env.ESZTER_ACCEPTANCE_CUSTOMER_EMAIL;
  if (!email || !password || !customerEmail) {
    throw new Error("Full mode requires ESZTER_ACCEPTANCE_ADMIN_EMAIL, ESZTER_ACCEPTANCE_ADMIN_PASSWORD and ESZTER_ACCEPTANCE_CUSTOMER_EMAIL.");
  }

  const session = await request("/api/auth/session");
  csrfToken = session.body?.csrfToken;
  const login = await request("/api/auth/login", {
    method: "POST", csrf: true, body: { email, password },
  });
  if (login.body?.authenticated !== true) throw new Error("Admin login did not produce an authenticated session.");
  csrfToken = login.body.csrfToken;

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mNkYGD4z8DAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), `${marker}.png`);
  const upload = await request("/api/admin/media", { method: "POST", csrf: true, body: form, expected: [201] });
  mediaId = upload.body?.asset?.id;
  if (!/^med_[0-9a-f]{32}$/.test(mediaId ?? "")) throw new Error("Media upload returned no valid id.");
  await request("/api/admin/media", { method: "DELETE", csrf: true, body: { id: mediaId }, expected: [204] });
  mediaId = null;

  const services = await request("/api/booking/services");
  const service = services.body?.services?.[0];
  if (!service?.key) throw new Error("No active booking service is available for acceptance.");
  const availability = await request("/api/booking/availability", {
    method: "POST",
    body: { serviceKey: service.key, fromDate: dateInParis(2), untilDate: dateInParis(60) },
  });
  const slot = availability.body?.slots?.[0];
  if (!slot?.startsAtUtc) throw new Error("No valid slot is available in the next 60 days; no booking was created.");

  const created = await request("/api/bookings", {
    method: "POST", expected: [201],
    body: {
      serviceKey: service.key,
      startsAtUtc: slot.startsAtUtc,
      customerName: marker,
      customerEmail,
      customerPhone: null,
      customerNote: `${marker} isolated production acceptance; cancel after verification`,
      // ESZ-142: the catalog's current consent notice id (booking-domain
      // consentNotices); membership acceptance keeps this valid forever.
      consentNoticeId: "booking-consent-v1",
      consentAccepted: true,
    },
  });
  bookingReference = created.body?.reference;
  if (!/^bk_[0-9a-f]{32}$/.test(bookingReference ?? "")) throw new Error("Booking creation returned no valid reference.");

  const query = await request("/api/admin/bookings/query", {
    method: "POST", body: { mode: "reference", reference: bookingReference },
  });
  const booking = query.body?.bookings?.[0];
  if (booking?.reference !== bookingReference || booking.state !== "confirmed") {
    throw new Error("The acceptance booking is absent from the admin calendar/query surface.");
  }
  await request("/api/admin/bookings", {
    method: "PATCH", csrf: true,
    body: {
      action: "update", reference: bookingReference,
      customerName: booking.customerName, customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone, customerNote: `${marker} admin mutation verified`,
    },
  });
  const cancelled = await request("/api/admin/bookings", {
    method: "PATCH", csrf: true,
    body: { action: "cancel", reference: bookingReference, reason: `${marker} cleanup` },
  });
  if (cancelled.body?.booking?.state !== "cancelled") throw new Error("Cleanup cancellation was not authoritative.");
  bookingCancelled = true;
  await request("/api/auth/logout", { method: "POST", csrf: true, expected: [204] });

  process.stdout.write(`\nHTTP acceptance completed for ${marker}.\n`);
  process.stdout.write(`Booking ${bookingReference} is cancelled; uploaded media was deleted.\n`);
  process.stdout.write("LIVE-PENDING: run/observe the authorized SMTP cron and verify the confirmation and cancellation messages in the approved mailbox, including the booking reference.\n");
  process.stdout.write("LIVE-PENDING: complete the browser viewport/interaction worksheet in docs/production-acceptance.md.\n");
}

try {
  process.stdout.write(`Target: ${target.origin}\nMode: ${confirmed ? "AUTHORIZED STATE-CHANGING" : "READ-ONLY"}\n`);
  await readOnlyChecks();
  if (!confirmed) {
    process.stdout.write(`Readiness PASS: liveness, public page, published content and booking services all answered. State-changing checks NOT RUN; exact --live-confirmation=${LIVE_CONFIRMATION} was not supplied.\n`);
  } else {
    await fullAcceptance();
  }
} catch (error) {
  process.stderr.write(`FAIL ${error.message}\n`);
  if (mediaId) process.stderr.write(`CLEANUP REQUIRED: delete media ${mediaId}.\n`);
  if (bookingReference && !bookingCancelled) process.stderr.write(`CLEANUP REQUIRED: cancel booking ${bookingReference}.\n`);
  process.exitCode = 1;
}
