#!/usr/bin/env node
/**
 * ESZ-124 — the canonical full-stack smoke (validate gate `php:smoke:full-stack`).
 *
 * What it proves, and why it is the canonical mutation proof:
 *
 * Real PHP, real MySQL, real content, auth, booking and admin paths are
 * exercised end to end — the injected public page and generated assets, HTTP
 * routing, deterministic availability, a real booking creation (carrying the
 * ESZ-142 consent-notice id), the anonymous-session bootstrap, an
 * authenticated admin login, the admin reference query and an admin cancel.
 * The smoke's own exit code is the outcome, so no skipped PHPUnit or missing
 * infrastructure can ever read as PASS.
 *
 * How it stays isolated and repeatable (ESZ-124):
 *
 *   - MySQL comes from the shared ESZ-112 disposable primitive
 *     (`scripts/sql-test-mysql.mjs`): one MySQL 8.4 container with a random
 *     identity, a collision-free published host port and an anonymous volume.
 *     The persistent `eszter_dev` development deployment (`compose.dev.yml`,
 *     `php/config/config.development.php`, `php/var/development/*`) is never
 *     bootstrapped, read or reset.
 *   - Runtime state — content, logs, tmp, locks, media originals, admin
 *     credentials, the configuration file — lives under one scratch root
 *     (`mkdtemp`, `eszter-full-stack-*`) that is removed on every exit.
 *   - The HTTP port is an ephemeral loopback port, collision-safe by
 *     construction (`ESZTER_FULL_STACK_SMOKE_PORT` overrides for debugging).
 *   - Cleanup runs on PASS, on assertion failure and on interruption
 *     (SIGINT/SIGTERM): the server is stopped, the container and its volume
 *     are removed, and the scratch root is deleted.
 *
 * The whole backing state is disposable, so the booking, its sessions, its
 * enqueued notification jobs and every log line die with the run: no
 * persistent booking/session/notification/database residue is possible.
 *
 * Test seams (documented, narrow, never active in a canonical run):
 *   - `ESZTER_FULL_STACK_SMOKE_SKIP_BUILD=1` — skip the frontend rebuild;
 *     the caller guarantees front/out is current (the lifecycle tests build
 *     once and then run several children).
 *   - `ESZTER_FULL_STACK_SMOKE_FAIL_STEP=after-stack` — fail right after the
 *     disposable stack is live, so lifecycle tests can prove that an
 *     assertion-style failure still removes every provisioned resource.
 *   - `ESZTER_FULL_STACK_SMOKE_PAUSE_MS=<ms>` — pause after the stack is
 *     live, so lifecycle tests can send SIGTERM/SIGINT and prove that an
 *     interruption removes every provisioned resource.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { disposeSqlTestMySql, provisionSqlTestMySql } from "./sql-test-mysql.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";

/** Every disposable smoke scratch root is created from this prefix. */
export const SMOKE_WORK_PREFIX = "eszter-full-stack-";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Single-quoted PHP string literal (safe for any config value). */
export function phpString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}${result.stderr || result.stdout ? `:\n${(result.stderr || result.stdout).trimEnd()}` : ""}`,
    );
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Reserves one ephemeral loopback port: collision-safe by construction. */
export async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, host, () => {
      const address = probe.address();
      const selected = typeof address === "object" && address ? address.port : null;
      probe.close((error) => {
        if (error) rejectPort(error);
        else if (selected === null) rejectPort(new Error("No free TCP port was allocated."));
        else resolvePort(selected);
      });
    });
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

/**
 * Health is a LIVENESS wait only: it reads no file and touches no database, so
 * a 200 proves the PHP process answers and nothing more. Composition readiness
 * (MySQL, booking, auth, admin) is proven by the flow that follows this wait —
 * it is what makes this smoke the full-stack readiness proof.
 */
async function waitUntilLive(baseUrl, description, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "server did not answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { accept: "application/json" } });
      if (response.status === 200) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${description} did not become live: ${lastError}`);
}

/**
 * Starts the disposable full-stack fixture: MySQL 8.4 container (ESZ-112
 * primitive), scratch content/log/lock/media/credential state, real schema
 * (php/bin/migrate.php) and deterministic fixtures
 * (php/bin/bootstrap-development.php) applied to it, then a real PHP
 * built-in server (`scripts/serve-php.mjs`) over the real export on a
 * collision-safe loopback port.
 *
 * Every resource is owned by the returned handle and removed by
 * `handle.cleanup()`. If any step fails, the resources created so far are
 * removed before the error is rethrown.
 *
 * @param {{ skipBuild?: boolean }} [options] skipBuild: front/out must already
 *   be current (the lifecycle tests build once). Default rebuilds the export.
 * @returns {Promise<object>} handle — { baseUrl, port, credentials,
 *   workRoot, configPath, mysql: { identity, containerName, databaseName,
 *   port }, cleanup: () => Promise<void> }
 */
export async function startSmokeStack({ skipBuild = false } = {}) {
  const prerequisites = [
    [join(repoRoot, "php", "vendor", "autoload.php"), "php/vendor — run `composer install --working-dir=php`"],
    [join(repoRoot, "php", "public", "router.php"), "php/public/router.php"],
    [join(repoRoot, "contracts", "generated", "manifest.json"), "contracts/generated — run `npm --prefix contracts run generate`"],
  ];
  for (const [path, label] of prerequisites) {
    if (!existsSync(path)) {
      throw new Error(`full-stack smoke: missing ${label} (${path}).`);
    }
  }

  if (!skipBuild) {
    process.stdout.write("full-stack smoke: building the real static export...\n");
    run("npm", ["--prefix", "front", "run", "build"], { stdio: "inherit" });
  }
  if (!existsSync(join(repoRoot, "front", "out", "index.html"))) {
    throw new Error(
      "full-stack smoke: front/out/index.html is missing. Run the frontend build first "
      + "or let the smoke build it (omit ESZTER_FULL_STACK_SMOKE_SKIP_BUILD).",
    );
  }

  // ── Disposable layout ────────────────────────────────────────────────────
  const workRoot = mkdtempSync(join(tmpdir(), SMOKE_WORK_PREFIX));
  chmodSync(workRoot, 0o700);
  process.stdout.write(`full-stack smoke: scratch runtime state under ${workRoot} — removed on every exit.\n`);
  const credentialsDir = join(workRoot, "credentials");
  const credentialsPath = join(credentialsDir, "admin.json");
  const configPath = join(workRoot, "config.php");
  for (const dir of [
    join(workRoot, "data", "content"),
    join(workRoot, "var", "tmp"),
    join(workRoot, "var", "locks"),
    join(workRoot, "var", "log"),
    join(workRoot, "media-originals"),
    credentialsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  let mysql = null;
  let server = null;
  let serverExit = null;

  const stopServer = async () => {
    if (!server || !serverExit) return;
    if (server.exitCode !== null || server.signalCode !== null) {
      await serverExit;
      server = null;
      serverExit = null;
      return;
    }
    server.kill("SIGTERM");
    const stoppedAfterTerm = await Promise.race([
      serverExit.then(() => true),
      sleep(3000).then(() => false),
    ]);
    if (!stoppedAfterTerm) {
      server.kill("SIGKILL");
      const stoppedAfterKill = await Promise.race([
        serverExit.then(() => true),
        sleep(3000).then(() => false),
      ]);
      if (!stoppedAfterKill) throw new Error("PHP server termination could not be confirmed.");
    }
    server = null;
    serverExit = null;
  };

  const cleanup = async () => {
    const errors = [];
    try {
      await stopServer();
    } catch (error) {
      errors.push(`server: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (mysql) {
      try {
        const removed = disposeSqlTestMySql(mysql);
        if (!removed.ok) errors.push("mysql: container removal was not confirmed");
      } catch (error) {
        errors.push(`mysql: ${error instanceof Error ? error.message : String(error)}`);
      }
      mysql = null;
    }
    try {
      rmSync(workRoot, { recursive: true, force: true });
    } catch (error) {
      errors.push(`scratch root: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (errors.length > 0) {
      throw new Error(`full-stack smoke: cleanup incomplete — ${errors.join("; ")}`);
    }
  };

  try {
    // The shared ESZ-112 primitive: one disposable MySQL 8.4 instance, random
    // identity and host port, database name ending in `_test`, credentials
    // generated for this run only. Never eszter_dev, never compose.dev.yml.
    mysql = provisionSqlTestMySql();
    process.stdout.write(
      `full-stack smoke: provisioned disposable MySQL ${mysql.databaseName} (127.0.0.1:${mysql.port}, container ${mysql.containerName}) — removed on every exit.\n`,
    );

    // Application configuration for the scratch stack. Absolute host paths
    // (the PHP server runs on this host); every private path sits under the
    // scratch root, above nothing web-reachable. Environment is `development`
    // so the seeding CLI and the non-Secure local session cookie are legal.
    writeFileSync(
      configPath,
      `<?php
declare(strict_types=1);
return [
  'environment' => 'development',
  'logLevel' => 'debug',
  'paths' => [
    'content' => ${phpString(join(workRoot, "data", "content"))},
    'tmp' => ${phpString(join(workRoot, "var", "tmp"))},
    'locks' => ${phpString(join(workRoot, "var", "locks"))},
    'log' => ${phpString(join(workRoot, "var", "log"))},
    'contracts' => ${phpString(join(repoRoot, "contracts", "generated"))},
    'mediaOriginals' => ${phpString(join(workRoot, "media-originals"))},
    'public' => ${phpString(join(repoRoot, "front", "out"))},
  ],
  'database' => [
    'dsn' => ${phpString(mysql.env.ESZTER_TEST_DB_DSN)},
    'username' => ${phpString(mysql.env.ESZTER_TEST_DB_USERNAME)},
    'password' => ${phpString(mysql.env.ESZTER_TEST_DB_PASSWORD)},
    'connectTimeoutSeconds' => 5,
  ],
  'session' => ['cookieSecure' => false, 'idleTimeoutSeconds' => 3600, 'absoluteTimeoutSeconds' => 43200],
];
`,
      { mode: 0o600 },
    );

    process.stdout.write("full-stack smoke: applying real migrations to the disposable MySQL...\n");
    run("php", ["php/bin/migrate.php", `--config=${configPath}`]);

    process.stdout.write("full-stack smoke: seeding deterministic development fixtures...\n");
    run("php", [
      "php/bin/bootstrap-development.php",
      `--config=${configPath}`,
      `--credentials-file=${credentialsPath}`,
    ]);

    const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert(typeof credentials.email === "string" && typeof credentials.password === "string", "no development credentials were written");

    const port = process.env.ESZTER_FULL_STACK_SMOKE_PORT
      ? Number(process.env.ESZTER_FULL_STACK_SMOKE_PORT)
      : await freePort();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid smoke port ${port}`);
    }
    const baseUrl = `http://${host}:${port}`;

    process.stdout.write(`full-stack smoke: starting the real PHP built-in server at ${baseUrl}...\n`);
    server = spawn(
      "node",
      ["scripts/serve-php.mjs", `--host=${host}`, `--port=${port}`, "--skip-build", "--skip-bootstrap"],
      {
        cwd: repoRoot,
        env: { ...process.env, ESZTER_CONFIG: configPath },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    serverExit = new Promise((resolveExit) => server.once("exit", resolveExit));
    server.once("error", (error) => {
      process.stderr.write(`full-stack smoke: PHP launcher error: ${error.message}\n`);
    });

    await waitUntilLive(baseUrl, "PHP server");
    process.stdout.write(`full-stack smoke: stack live at ${baseUrl} — content, auth, booking and admin all sit on the disposable MySQL.\n`);

    return {
      baseUrl,
      port,
      credentials,
      workRoot,
      configPath,
      mysql: {
        identity: mysql.identity,
        containerName: mysql.containerName,
        databaseName: mysql.databaseName,
        port: mysql.port,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function setCookies(headers, cookies) {
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

function httpClient(baseUrl) {
  const cookies = new Map();
  async function request(path, init = {}) {
    const headers = new Headers(init.headers);
    if (cookies.size > 0) {
      headers.set("cookie", [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    setCookies(response.headers, cookies);
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
  function json(path, method, body, headers = {}) {
    return request(path, {
      method,
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return { request, json };
}

/**
 * The composed-product proof over a live disposable stack. The assertions are
 * the business assertions — they are not weakened to simplify the setup: the
 * public injected page, generated assets, routing contracts, deterministic
 * availability, a real booking creation, the anonymous-session bootstrap, an
 * authenticated admin login, the ESZ-145 admin reference query and an admin
 * cancel with the booking's optimistic-concurrency token, then logout and a
 * protected reload that must answer 401. Every persisted booking, session,
 * notification job and log line dies with the disposable backing state.
 *
 * @param {object} handle from startSmokeStack()
 * @param {{ shouldAbort?: () => boolean }} [options]
 */
export async function runSmokeProof(handle, { shouldAbort = () => false } = {}) {
  const { request, json } = httpClient(handle.baseUrl);
  const abort = () => {
    if (shouldAbort()) throw new Error("full-stack smoke interrupted");
  };

  const home = await request("/");
  assert(home.response.status === 200 && home.text.includes("__ESZTER_CONTENT__"), "GET / did not return the public HTML.");
  abort();

  const assetPath = /(?:src|href)="(\/_next\/static\/[^"?]+\.(?:css|js|woff2))/.exec(home.text)?.[1];
  assert(assetPath, "Could not find a generated frontend asset in GET /.");
  const asset = await fetch(`${handle.baseUrl}${assetPath}`);
  const assetBytes = await asset.arrayBuffer();
  assert(asset.status === 200 && assetBytes.byteLength > 0, `Frontend asset ${assetPath} did not resolve successfully.`);
  abort();

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
  abort();

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
  assert(Array.isArray(availability.body?.slots) && availability.body.slots.length > 0, "No deterministic development slots were returned.");
  const startsAtUtc = availability.body.slots[0]?.startsAtUtc;
  assert(typeof startsAtUtc === "string", "Availability slot has no UTC start.");
  abort();

  const created = await json("/api/bookings", "POST", {
    serviceKey,
    startsAtUtc,
    customerName: "Cliente Smoke",
    customerEmail: `smoke+${Date.now()}@example.test`,
    customerPhone: null,
    customerNote: "Created by the disposable full-stack smoke; the whole backing state is removed on every exit.",
    // ESZ-142: the catalog's current consent notice id.
    consentNoticeId: "booking-consent-v1",
    consentAccepted: true,
  });
  assert(created.response.status === 201, `Booking creation returned ${created.response.status}.`);
  const bookingReference = created.body?.reference ?? null;
  assert(/^bk_[0-9a-f]{32}$/.test(bookingReference ?? ""), "Booking creation returned no valid reference.");

  const anonymous = await request("/api/auth/session", { headers: { accept: "application/json" } });
  assert(anonymous.response.status === 200 && anonymous.body?.authenticated === false, "Anonymous session bootstrap failed.");
  assert(typeof anonymous.body?.csrfToken === "string", "Anonymous session returned no CSRF token.");
  abort();

  const login = await json(
    "/api/auth/login",
    "POST",
    { email: handle.credentials.email, password: handle.credentials.password },
    { "x-csrf-token": anonymous.body.csrfToken },
  );
  assert(login.response.status === 200 && login.body?.authenticated === true, "Development admin login failed.");
  const authenticatedCsrf = login.body?.csrfToken ?? null;
  assert(typeof authenticatedCsrf === "string", "Authenticated session returned no rotated CSRF token.");

  const query = await json(
    "/api/admin/bookings/query",
    "POST",
    { mode: "reference", reference: bookingReference },
  );
  assert(query.response.status === 200, `Admin booking query returned ${query.response.status}.`);
  // ESZ-145: the reference read serves the booking's current facts as `booking`
  // beside one bounded `historyPage`; the old `bookings` array is gone.
  assert(
    query.body?.booking !== null && typeof query.body?.booking === "object",
    "Reference query did not return the ESZ-145 booking envelope.",
  );
  const queriedBooking = query.body.booking;
  assert(
    queriedBooking.reference === bookingReference,
    "Created booking is not visible through the authenticated admin surface.",
  );
  // ESZ-139: every update/move/cancel mutation must carry the booking's current
  // updatedAt token; the reference read just provided a fresh authoritative one.
  assert(
    typeof queriedBooking.updatedAt === "string" && queriedBooking.updatedAt !== "",
    "Reference query returned a booking without its optimistic-concurrency updatedAt.",
  );
  abort();

  const cancelled = await json(
    "/api/admin/bookings",
    "PATCH",
    {
      action: "cancel",
      reference: bookingReference,
      reason: "Full-stack smoke",
      expectedUpdatedAt: queriedBooking.updatedAt,
    },
    { "x-csrf-token": authenticatedCsrf },
  );
  assert(cancelled.response.status === 200, `Admin cancel returned ${cancelled.response.status}.`);

  const logout = await json(
    "/api/auth/logout",
    "POST",
    undefined,
    { "x-csrf-token": authenticatedCsrf },
  );
  assert(logout.response.status === 204, `Logout returned ${logout.response.status}.`);

  const protectedAfterLogout = await json(
    "/api/admin/bookings/query",
    "POST",
    { mode: "range", fromDate, untilDate },
  );
  assert(protectedAfterLogout.response.status === 401, "Admin API remained accessible after logout.");
  abort();

  return bookingReference;
}

async function main() {
  const skipBuild = process.env.ESZTER_FULL_STACK_SMOKE_SKIP_BUILD === "1";
  const failStep = process.env.ESZTER_FULL_STACK_SMOKE_FAIL_STEP ?? null;
  const pauseMs = Number(process.env.ESZTER_FULL_STACK_SMOKE_PAUSE_MS ?? 0);

  let interrupted = false;
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(`\nfull-stack smoke: ${signal} received — removing the disposable stack, then stopping.\n`);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  let handle = null;
  let failure = null;
  let cleanupFailure = null;
  let successMessage = null;

  try {
    handle = await startSmokeStack({ skipBuild });

    // Interruption seam: keep the process alive with the stack fully
    // provisioned so a lifecycle test can send SIGTERM/SIGINT mid-run.
    if (Number.isFinite(pauseMs) && pauseMs > 0) {
      process.stdout.write(`full-stack smoke: pausing ${pauseMs} ms with the stack live (interruption seam).\n`);
      const pauseDeadline = Date.now() + pauseMs;
      while (Date.now() < pauseDeadline && !interrupted) {
        await sleep(50);
      }
    }

    // Failure-injection seam (lifecycle tests): an assertion-style failure
    // right after the stack is live must still remove every resource.
    if (failStep === "after-stack") {
      throw new Error("injected failure after stack start (ESZTER_FULL_STACK_SMOKE_FAIL_STEP test seam)");
    }

    if (interrupted) throw new Error("interrupted before the proof ran");

    const bookingReference = await runSmokeProof(handle, { shouldAbort: () => interrupted });
    if (interrupted) throw new Error("interrupted during the proof");
    successMessage =
      `full-stack smoke: PASS — public page, assets, routing, availability, booking creation (${bookingReference}), `
      + "MySQL-backed admin login/query/cancel and logout compose correctly over the disposable stack; "
      + "the MySQL container, its volume and the scratch state are removed now.\n";
  } catch (error) {
    if (interrupted) {
      failure = new Error(`interrupted: ${error instanceof Error ? error.message : String(error)}`);
    } else {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  } finally {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (error) {
        cleanupFailure = error;
      }
      handle = null;
    }
  }

  if (interrupted) {
    process.stderr.write(
      cleanupFailure
        ? `full-stack smoke: interrupted; cleanup failed — ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}\n`
        : "full-stack smoke: interrupted; disposable stack removed.\n",
    );
    return 130;
  }
  if (failure !== null) {
    process.stderr.write(`full-stack smoke: FAIL — ${failure.message}\n`);
    if (cleanupFailure !== null) {
      process.stderr.write(
        `full-stack smoke: cleanup also failed — ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}\n`,
      );
    }
    return 1;
  }
  if (cleanupFailure !== null) {
    process.stderr.write(`full-stack smoke: FAIL — ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}\n`);
    return 1;
  }
  // PASS is only claimed once the disposable resources are confirmed removed.
  process.stdout.write(successMessage ?? "full-stack smoke: PASS\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`full-stack smoke: runner error: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    },
  );
}
