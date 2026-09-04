#!/usr/bin/env node

/**
 * Project-owned, read-only **readiness** probe (ESZ-127/AUD-22).
 *
 * Liveness and readiness are deliberately separate answers:
 *
 * - `GET /api/health` is **liveness**: the handler reads no file, takes no lock
 *   and touches no database, so a 200 means only that the PHP service can boot
 *   and answer. That endpoint is frozen and unchanged.
 * - Readiness is the composed-HTTP-product question: is the service live AND
 *   can a visitor actually use the product? It is answered here, by probing
 *   four surfaces of a supplied origin, and nowhere else. There is deliberately
 *   no `/api/readiness` endpoint: the shared-hosting target exposes the frozen
 *   HTTP surface and nothing more, and this probe is the project-owned tool
 *   that production acceptance and operators reuse instead of duplicating
 *   checks.
 *
 * A PASS requires, in this frozen order:
 *
 * 1. `health`    — `/api/health` answers 200 with the frozen health payload
 *    (`status: "ok"`, `service: "eszter-api"`, `contentSchemaVersion`,
 *    `timestamp`). Liveness under its contract.
 * 2. `page`      — `/` serves the exported Eszter page: `text/html`, with the
 *    `__ESZTER_CONTENT__` bootstrap element and the baked site name. This is a
 *    shell check: the page may legitimately serve baked defaults when the
 *    published envelope is unusable (a design property, not a readiness
 *    failure) — readiness gets its content truth from `/api/content`, never
 *    from the page's injected copy.
 * 3. `content`   — `/api/content` answers 200 with a valid published envelope
 *    (a `content` document and a non-negative integer `revision`).
 * 4. `booking`   — `/api/booking/services` answers 200 with at least one
 *    well-formed active bookable service. This is the surface that reaches the
 *    real booking/MySQL wiring, so it is what makes readiness fail when the
 *    database is unavailable while the service itself stays live.
 *
 * The probe is strictly read-only: no session is opened, nothing is uploaded,
 * no booking is created, no cron runs and no SMTP contact happens.
 *
 * Failures are deterministic and identify only the failed component. A failure
 * reason names the public path that failed and, at most, an HTTP status or a
 * transport error code — never a response body, so a misbehaving origin cannot
 * leak DSNs, credentials or path internals through this tool.
 *
 * This module is dependency-free (Node built-ins only) so it runs from a bare
 * checkout and inside release bundles. See `docs/production-acceptance.md` and
 * `docs/contract-freeze.md` for the documented liveness/readiness boundary.
 */

export const READINESS_COMPONENTS = Object.freeze(["health", "page", "content", "booking"]);

const HEALTH_PATH = "/api/health";
const PAGE_PATH = "/";
const CONTENT_PATH = "/api/content";
const BOOKING_SERVICES_PATH = "/api/booking/services";

const HEALTH_SERVICE_NAME = "eszter-api";

/** Cap on how much of a response body the probe reads; enough for every real surface. */
const MAX_BODY_BYTES = 65_536;

/** @param {unknown} origin */
function normalizeOrigin(origin) {
  let url;
  try {
    url = new URL(String(origin));
  } catch {
    throw new Error(`Readiness origin is not a valid URL: ${origin}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The readiness origin must be an http:// or https:// origin.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("The readiness origin must not carry embedded credentials.");
  }
  if (url.pathname !== "/") {
    throw new Error("The readiness origin must be an origin URL ending at `/`, with no path.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("The readiness origin must carry no query string or fragment.");
  }
  return url.origin;
}

/**
 * A transport failure becomes a short, deterministic reason: the public path
 * plus an error code when one exists. The underlying message is never used —
 * it can embed addresses or other internals that have no place in a report.
 */
function networkCode(error) {
  const cause = error?.cause;
  const code = cause && typeof cause === "object" && "code" in cause
    ? cause.code
    : error?.code;
  if (typeof code === "string" && code !== "") return code;
  if (error?.name === "TimeoutError") return "TIMEOUT";
  return "network error";
}

async function readBodyLimited(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total <= MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > MAX_BODY_BYTES) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    .toString("utf8")
    .slice(0, MAX_BODY_BYTES);
}

/**
 * One GET against the origin. Never follows redirects and never reads more
 * than {@link MAX_BODY_BYTES} of body, so a 3xx or an oversized reply is a
 * deterministic failure rather than an accidental chase.
 *
 * @returns {Promise<{status: number, contentType: string, body: string}>}
 */
async function getOnce(origin, path, timeoutMs) {
  const response = await fetch(`${origin}${path}`, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await readBodyLimited(response),
  };
}

function parsedJson(reply) {
  if (reply.body === "") return null;
  try {
    return JSON.parse(reply.body);
  } catch {
    return null;
  }
}

function healthOutcome(reply) {
  const body = parsedJson(reply);
  if (body === null || typeof body !== "object") {
    return { passed: false, reason: `GET ${HEALTH_PATH} body is not the frozen health payload` };
  }
  const contentSchemaVersion = body.contentSchemaVersion;
  const timestamp = body.timestamp;
  const contractHeld = body.status === "ok"
    && body.service === HEALTH_SERVICE_NAME
    && contentSchemaVersion === 1 // SITE_CONTENT_SCHEMA_VERSION in contracts/site-content.ts.
    && typeof timestamp === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp);
  if (!contractHeld) {
    return { passed: false, reason: `GET ${HEALTH_PATH} body is not the frozen health payload` };
  }
  return { passed: true };
}

function pageOutcome(reply) {
  if (!reply.contentType.toLowerCase().startsWith("text/html")) {
    return { passed: false, reason: `GET ${PAGE_PATH} did not answer text/html` };
  }
  if (!reply.body.includes("__ESZTER_CONTENT__") || !reply.body.includes("Eszter Gyori")) {
    return { passed: false, reason: `GET ${PAGE_PATH} lacks the Eszter public-page markers` };
  }
  return { passed: true };
}

function contentOutcome(reply) {
  const body = parsedJson(reply);
  const content = body?.content;
  if (
    body === null
    || typeof body !== "object"
    || !Number.isInteger(body.revision)
    || body.revision < 0
    || content === null
    || typeof content !== "object"
  ) {
    return { passed: false, reason: `GET ${CONTENT_PATH} envelope is not the published document` };
  }
  return { passed: true };
}

function bookingOutcome(reply) {
  const body = parsedJson(reply);
  const services = body?.services;
  if (!Array.isArray(services) || services.length === 0) {
    return { passed: false, reason: `GET ${BOOKING_SERVICES_PATH} returned no active bookable service` };
  }
  const wellFormed = services.every((service) => service !== null
    && typeof service === "object"
    && typeof service.key === "string"
    && service.key !== ""
    && typeof service.label === "string"
    && service.label !== ""
    && Number.isInteger(service.durationMinutes)
    && service.durationMinutes >= 1);
  if (!wellFormed) {
    return { passed: false, reason: `GET ${BOOKING_SERVICES_PATH} returned a malformed service entry` };
  }
  return { passed: true };
}

const CHECKERS = {
  health: { path: HEALTH_PATH, outcome: healthOutcome },
  page: { path: PAGE_PATH, outcome: pageOutcome },
  content: { path: CONTENT_PATH, outcome: contentOutcome },
  booking: { path: BOOKING_SERVICES_PATH, outcome: bookingOutcome },
};

/**
 * Probe the composed HTTP product at one origin.
 *
 * @param {string|URL} origin http(s) origin with no credentials, path, query or fragment.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{
 *   origin: string,
 *   ready: boolean,
 *   failures: string[],
 *   components: Record<string, {passed: boolean, reason?: string}>,
 * }>}
 */
export async function probeReadiness(origin, { timeoutMs = 5_000 } = {}) {
  const target = normalizeOrigin(origin);
  const components = {};
  const failures = [];
  for (const name of READINESS_COMPONENTS) {
    const { path, outcome } = CHECKERS[name];
    let result;
    try {
      const reply = await getOnce(target, path, timeoutMs);
      result = reply.status === 200 ? outcome(reply)
        : { passed: false, reason: `GET ${path} answered HTTP ${reply.status}` };
    } catch (error) {
      result = { passed: false, reason: `GET ${path} failed (${networkCode(error)})` };
    }
    components[name] = result;
    if (!result.passed) failures.push(name);
  }
  return { origin: target, ready: failures.length === 0, failures, components };
}
