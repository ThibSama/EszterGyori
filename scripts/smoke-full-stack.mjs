#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const port = process.env.ESZTER_FULL_STACK_SMOKE_PORT ?? "8091";
const baseUrl = `http://${host}:${port}`;
const credentialsFile = join(repoRoot, "php", "var", "development", "development-admin.json");
const cookies = new Map();
let server;
let serverExit;
let bookingReference = null;
let authenticatedCsrf = null;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}.`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function setCookies(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const [pair] = value.split(";", 1);
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (/max-age=0/i.test(value) || cookieValue === "") cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookies.size > 0) {
    headers.set("cookie", [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  setCookies(response.headers);
  const text = await response.text();
  let body = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, text };
}

async function json(path, method, body, headers = {}) {
  return request(path, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function parisDate(daysFromNow) {
  const date = new Date(Date.now() + daysFromNow * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

async function waitUntilReady() {
  const deadline = Date.now() + 45_000;
  let lastError = "server did not answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { accept: "application/json" } });
      if (response.status === 200) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`PHP server did not become ready: ${lastError}`);
}

async function cleanupBooking() {
  if (bookingReference === null || authenticatedCsrf === null) return;
  try {
    await json(
      "/api/admin/bookings",
      "PATCH",
      { action: "cancel", reference: bookingReference, reason: "Full-stack smoke cleanup" },
      { "x-csrf-token": authenticatedCsrf },
    );
  } catch {
    // The primary failure is reported by the smoke itself; cleanup is best effort.
  }
}

async function stopServer() {
  if (!server || !serverExit) return;
  if (server.exitCode !== null || server.signalCode !== null) {
    await serverExit;
    return;
  }

  server.kill("SIGTERM");
  const stoppedAfterTerm = await Promise.race([
    serverExit.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 3000)),
  ]);
  if (stoppedAfterTerm) return;

  server.kill("SIGKILL");
  const stoppedAfterKill = await Promise.race([
    serverExit.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 3000)),
  ]);
  if (!stoppedAfterKill) throw new Error("PHP server termination could not be confirmed.");
}

let smokeFailure = null;
let shutdownFailure = null;

try {
  process.stdout.write("full-stack smoke: bootstrapping deterministic local dependencies...\n");
  run("node", ["scripts/bootstrap-development.mjs", "--quiet"]);

  process.stdout.write("full-stack smoke: building the real static export...\n");
  run("npm", ["--prefix", "front", "run", "build"]);

  server = spawn(
    "node",
    ["scripts/serve-php.mjs", `--host=${host}`, `--port=${port}`, "--skip-build", "--skip-bootstrap"],
    { cwd: repoRoot, env: process.env, stdio: ["ignore", "inherit", "inherit"] },
  );
  serverExit = new Promise((resolveExit) => server.once("exit", resolveExit));
  server.once("error", (error) => {
    process.stderr.write(`full-stack smoke: PHP launcher error: ${error.message}\n`);
  });
  await waitUntilReady();

  const home = await request("/");
  assert(home.response.status === 200 && home.text.includes("__ESZTER_CONTENT__"), "GET / did not return the public HTML.");

  const assetPath = /(?:src|href)="(\/_next\/static\/[^"?]+\.(?:css|js|woff2))/.exec(home.text)?.[1];
  assert(assetPath, "Could not find a generated frontend asset in GET /.");
  const asset = await fetch(`${baseUrl}${assetPath}`);
  const assetBytes = await asset.arrayBuffer();
  assert(asset.status === 200 && assetBytes.byteLength > 0, `Frontend asset ${assetPath} did not resolve successfully.`);

  const reservation = await request("/reservation");
  assert(
    reservation.response.status === 200 && reservation.text.includes("reservation-main"),
    "GET /reservation did not return the reservation application.",
  );

  const unknownPage = await request("/route-that-does-not-exist");
  assert(
    unknownPage.response.status === 404 && unknownPage.text.includes("404"),
    `Unknown public route returned ${unknownPage.response.status} without the exported 404 page.`,
  );

  const unknownApi = await request("/api/route-that-does-not-exist", { headers: { accept: "application/json" } });
  assert(
    unknownApi.response.status === 404 && unknownApi.body?.error?.code === "NOT_FOUND",
    `Unknown API route violated the JSON 404 contract: ${unknownApi.response.status}.`,
  );

  const services = await request("/api/booking/services", { headers: { accept: "application/json" } });
  assert(services.response.status === 200, `GET /api/booking/services returned ${services.response.status}.`);
  assert(Array.isArray(services.body?.services) && services.body.services.length >= 4, "Bookable service fixtures are missing.");
  const serviceKey = services.body.services[0]?.key;
  assert(typeof serviceKey === "string", "First bookable service has no key.");

  const fromDate = parisDate(1);
  const untilDate = parisDate(14);
  const availability = await json(
    "/api/booking/availability",
    "POST",
    { serviceKey, fromDate, untilDate },
  );
  assert(availability.response.status === 200, `Availability returned ${availability.response.status}.`);
  assert(Array.isArray(availability.body?.slots) && availability.body.slots.length > 0, "No local development slots were returned.");
  const startsAtUtc = availability.body.slots[0]?.startsAtUtc;
  assert(typeof startsAtUtc === "string", "Availability slot has no UTC start.");

  const created = await json("/api/bookings", "POST", {
    serviceKey,
    startsAtUtc,
    customerName: "Cliente Smoke",
    customerEmail: `smoke+${Date.now()}@example.test`,
    customerPhone: null,
    customerNote: "Created by the project-owned full-stack smoke and cancelled during cleanup.",
    // ESZ-142: the catalog's current consent notice id.
    consentNoticeId: "booking-consent-v1",
    consentAccepted: true,
  });
  assert(created.response.status === 201, `Booking creation returned ${created.response.status}.`);
  bookingReference = created.body?.reference ?? null;
  assert(/^bk_[0-9a-f]{32}$/.test(bookingReference ?? ""), "Booking creation returned no valid reference.");

  const anonymous = await request("/api/auth/session", { headers: { accept: "application/json" } });
  assert(anonymous.response.status === 200 && anonymous.body?.authenticated === false, "Anonymous session bootstrap failed.");
  assert(typeof anonymous.body?.csrfToken === "string", "Anonymous session returned no CSRF token.");

  const credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
  const login = await json(
    "/api/auth/login",
    "POST",
    { email: credentials.email, password: credentials.password },
    { "x-csrf-token": anonymous.body.csrfToken },
  );
  assert(login.response.status === 200 && login.body?.authenticated === true, "Development admin login failed.");
  authenticatedCsrf = login.body?.csrfToken ?? null;
  assert(typeof authenticatedCsrf === "string", "Authenticated session returned no rotated CSRF token.");

  const query = await json(
    "/api/admin/bookings/query",
    "POST",
    { mode: "reference", reference: bookingReference },
  );
  assert(query.response.status === 200, `Admin booking query returned ${query.response.status}.`);
  assert(
    Array.isArray(query.body?.bookings) && query.body.bookings.some((booking) => booking.reference === bookingReference),
    "Created booking is not visible through the authenticated admin surface.",
  );

  const cancelled = await json(
    "/api/admin/bookings",
    "PATCH",
    { action: "cancel", reference: bookingReference, reason: "Full-stack smoke cleanup" },
    { "x-csrf-token": authenticatedCsrf },
  );
  assert(cancelled.response.status === 200, `Booking cleanup returned ${cancelled.response.status}.`);
  bookingReference = null;

  const logout = await json(
    "/api/auth/logout",
    "POST",
    undefined,
    { "x-csrf-token": authenticatedCsrf },
  );
  assert(logout.response.status === 204, `Logout returned ${logout.response.status}.`);
  authenticatedCsrf = null;

  const protectedAfterLogout = await json(
    "/api/admin/bookings/query",
    "POST",
    { mode: "range", fromDate, untilDate },
  );
  assert(protectedAfterLogout.response.status === 401, "Admin API remained accessible after logout.");

} catch (error) {
  await cleanupBooking();
  smokeFailure = error;
} finally {
  try {
    await stopServer();
  } catch (error) {
    shutdownFailure = error;
  }
}

if (smokeFailure !== null) {
  process.stderr.write(`full-stack smoke: FAIL — ${smokeFailure instanceof Error ? smokeFailure.message : String(smokeFailure)}\n`);
  if (shutdownFailure !== null) {
    process.stderr.write(
      `full-stack smoke: shutdown also failed — ${shutdownFailure instanceof Error ? shutdownFailure.message : String(shutdownFailure)}\n`,
    );
  }
  process.exitCode = 1;
} else if (shutdownFailure !== null) {
  process.stderr.write(
    `full-stack smoke: FAIL — ${shutdownFailure instanceof Error ? shutdownFailure.message : String(shutdownFailure)}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "full-stack smoke: PASS — public, assets, routing, booking, MySQL, auth, admin and shutdown compose correctly.\n",
  );
}
