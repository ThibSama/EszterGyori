#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeBinary = process.env.ESZTER_BOOKING_CONTACT_CHROME ?? "google-chrome";
const workRoot = mkdtempSync(join(tmpdir(), "eszter-booking-contact-"));
const chromeProfile = join(workRoot, "chrome-profile");
const configPath = join(workRoot, "config.php");
const credentialsPath = join(workRoot, "admin.json");
const mysqlContainerName = "eszter_booking_contact_proof";
const databaseName = "eszter_booking_contact_proof";
const databaseUsername = "eszter_booking_contact_proof";
const databasePassword = "eszter_booking_contact_only";
const databaseRootPassword = "eszter_booking_contact_root_only";
const initialContact = {
  customerName: "Cliente Preuve Contact",
  customerEmail: "cliente.preuve@example.test",
  customerPhone: "+33102030405",
  customerNote: "Coordonnées initiales de la preuve navigateur.",
};
const updatedContact = {
  customerName: "Représentante Camille Martin",
  customerEmail: "camille.martin@example.test",
  customerPhone: "+33611223344",
  customerNote: "Nouvelle représentante, joindre de préférence le matin.",
};
let mysqlContainer = null;
let phpServer = null;
let phpServerExit = null;
let chrome = null;

function fail(message) {
  throw new Error(`admin booking contact browser proof: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout?.trim() ?? "";
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  fail(`${description} did not become ready${lastError ? `: ${lastError.message}` : ""}`);
}

async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close((error) => {
        if (error) rejectPort(error);
        else if (port === null) rejectPort(new Error("No free TCP port was allocated."));
        else resolvePort(port);
      });
    });
  });
}

function parisToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function phpString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** The exact label prefix the calendar's day cells carry (formatParisDate + ", "). */
function parisDayCellPrefix(date) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("weekday")} ${pick("day")} ${pick("month")} ${pick("year")}, `;
}

function addParisDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener("open", resolveReady, { once: true });
      this.socket.addEventListener("error", () => rejectReady(new Error("Chrome DevTools connection failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolveResult, rejectResult) => {
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description ?? "browser evaluation failed");
  return result.result.value;
}

async function setReactField(cdp, id, value) {
  const changed = await evaluate(cdp, `(() => {
    const field = document.getElementById(${JSON.stringify(id)});
    const prototype = field instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : null;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!field || !setter) return false;
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  assert(changed, `could not edit #${id}`);
  await waitFor(
    () => evaluate(cdp, `document.getElementById(${JSON.stringify(id)})?.value === ${JSON.stringify(value)}`),
    `#${id} edit`,
  );
}

async function clickButton(cdp, label) {
  const clicked = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
    button?.click();
    return Boolean(button);
  })()`);
  assert(clicked, `could not click ${label}`);
}

async function openBooking(cdp, name, localDate) {
  // The month grid always includes the next several days, so the booking's day
  // cell (aria-label "mardi 1 septembre 2026, N rendez-vous") is reachable even
  // when the slot fell on a later day than today (e.g. a Sunday booking). The
  // grid only renders once the month query has finished loading, so wait for
  // the cell before clicking it.
  const prefix = parisDayCellPrefix(localDate);
  await waitFor(
    () => evaluate(cdp, `[...document.querySelectorAll("button")].some((candidate) => candidate.getAttribute("aria-label")?.startsWith(${JSON.stringify(prefix)}))`),
    `calendar day cell ${localDate}`,
    45_000,
  );
  const dayCell = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label")?.startsWith(${JSON.stringify(prefix)}));
    button?.click();
    return Boolean(button);
  })()`);
  assert(dayCell, `could not open the calendar day ${localDate}`);
  await waitFor(
    () => evaluate(cdp, `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Jour" && button.getAttribute("aria-pressed") === "true")`),
    "day view activation",
  );
  await waitFor(
    () => evaluate(cdp, `[...document.querySelectorAll("button")].some((button) => button.textContent?.includes(${JSON.stringify(name)}))`),
    `day-view booking ${name}`,
  );
  const opened = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(${JSON.stringify(name)}));
    button?.click();
    return Boolean(button);
  })()`);
  assert(opened, `could not open booking ${name}`);
  await waitFor(
    () => evaluate(cdp, `document.querySelector('aside h2')?.textContent?.trim() === ${JSON.stringify(name)}`),
    `booking detail ${name}`,
  );
}

async function assertDetail(cdp, contact, description) {
  await waitFor(
    () => evaluate(cdp, `(() => {
      const aside = document.querySelector("aside");
      return aside?.querySelector("h2")?.textContent?.trim() === ${JSON.stringify(contact.customerName)}
        && aside?.querySelector(${JSON.stringify(`a[href="mailto:${contact.customerEmail}"]`)})?.textContent?.trim() === ${JSON.stringify(contact.customerEmail)}
        && aside?.querySelector(${JSON.stringify(`a[href="tel:${contact.customerPhone}"]`)})?.textContent?.trim() === ${JSON.stringify(contact.customerPhone)}
        && aside?.textContent?.includes(${JSON.stringify(contact.customerNote)});
    })()`),
    description,
  );
}

function createCookieClient(origin) {
  const cookies = new Map();
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookies.size) headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await fetch(`${origin}${path}`, { ...init, headers });
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of setCookies) {
      const [pair] = value.split(";", 1);
      const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  };
}

async function stopProcess(process, exitPromise) {
  if (!process || !exitPromise || process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  const stopped = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 3000)),
  ]);
  if (!stopped) process.kill("SIGKILL");
}

async function main() {
  assert(existsSync(join(repoRoot, "front", "out", "index.html")), "front/out is missing; run npm run build first");
  assert(existsSync(join(repoRoot, "php", "vendor", "autoload.php")), "php/vendor is missing; install Composer dependencies first");

  mysqlContainer = run("docker", [
    "run", "--detach", "--rm", "--name", mysqlContainerName, "--publish", "127.0.0.1::3306",
    "--env", "MYSQL_DATABASE", "--env", "MYSQL_USER", "--env", "MYSQL_PASSWORD", "--env", "MYSQL_ROOT_PASSWORD",
    "mysql:8.4",
  ], {
    env: {
      ...process.env,
      MYSQL_DATABASE: databaseName,
      MYSQL_USER: databaseUsername,
      MYSQL_PASSWORD: databasePassword,
      MYSQL_ROOT_PASSWORD: databaseRootPassword,
    },
  });
  await waitFor(() => spawnSync("docker", [
    "exec", mysqlContainerName, "sh", "-lc", 'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent',
  ], { stdio: "ignore" }).status === 0, "isolated MySQL", 60_000);
  const databasePort = /:(\d+)$/.exec(run("docker", ["port", mysqlContainerName, "3306/tcp"]))?.[1];
  assert(databasePort, "could not resolve the isolated MySQL port");

  writeFileSync(configPath, `<?php\ndeclare(strict_types=1);\nreturn [
  'environment' => 'development',
  'logLevel' => 'debug',
  'paths' => [
    'content' => ${phpString(join(workRoot, "content"))},
    'tmp' => ${phpString(join(workRoot, "tmp"))},
    'locks' => ${phpString(join(workRoot, "locks"))},
    'log' => ${phpString(join(workRoot, "log"))},
    'contracts' => ${phpString(join(repoRoot, "contracts", "generated"))},
    'mediaOriginals' => ${phpString(join(workRoot, "media-originals"))},
    'public' => ${phpString(join(repoRoot, "front", "out"))},
  ],
  'database' => [
    'dsn' => 'mysql:host=127.0.0.1;port=${databasePort};dbname=${databaseName};charset=utf8mb4',
    'username' => '${databaseUsername}',
    'password' => '${databasePassword}',
    'connectTimeoutSeconds' => 5,
  ],
  'session' => ['cookieSecure' => false, 'idleTimeoutSeconds' => 3600, 'absoluteTimeoutSeconds' => 43200],
];\n`, { mode: 0o600 });
  run("php", ["php/bin/migrate.php", `--config=${configPath}`]);
  run("php", ["php/bin/bootstrap-development.php", `--config=${configPath}`, `--credentials-file=${credentialsPath}`]);
  const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));

  const httpPort = await freePort();
  const origin = `http://127.0.0.1:${httpPort}`;
  phpServer = spawn("php", [
    "-S", `127.0.0.1:${httpPort}`, "-t", join(repoRoot, "front", "out"), join(repoRoot, "php", "public", "router.php"),
  ], { cwd: repoRoot, env: { ...process.env, ESZTER_CONFIG: configPath }, stdio: ["ignore", "ignore", "pipe"] });
  phpServerExit = new Promise((resolveExit) => phpServer.once("exit", resolveExit));
  await waitFor(async () => (await fetch(`${origin}/api/health`)).status === 200, "isolated PHP application", 45_000);

  const today = parisToday();
  const servicesResponse = await fetch(`${origin}/api/booking/services`, { headers: { accept: "application/json" } });
  const services = await servicesResponse.json();
  assert(servicesResponse.status === 200 && services.services?.length, "public services were not available");
  const serviceKey = services.services[0].key;
  // Dev fixtures open Monday–Saturday, so on a Sunday the first real slot is
  // tomorrow; the calendar day-cell navigation below reaches any of the next
  // days without extra month navigation.
  let bookingDate = null;
  let startsAtUtc = null;
  for (let offset = 0; offset < 7; ++offset) {
    const candidate = offset === 0 ? today : addParisDays(today, offset);
    const availabilityResponse = await fetch(`${origin}/api/booking/availability`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ serviceKey, fromDate: candidate, untilDate: candidate }),
    });
    const availability = await availabilityResponse.json();
    assert(availabilityResponse.status === 200, `availability query failed for ${candidate}`);
    if (availability.slots?.length) {
      bookingDate = candidate;
      startsAtUtc = availability.slots[0].startsAtUtc;
      break;
    }
  }
  assert(bookingDate !== null && typeof startsAtUtc === "string", "no real slot was available in the next seven days");
  const creationResponse = await fetch(`${origin}/api/bookings`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      serviceKey,
      startsAtUtc,
      ...initialContact,
      // ESZ-142: the catalog's current consent notice id.
      consentNoticeId: "booking-consent-v1",
      consentAccepted: true,
    }),
  });
  const created = await creationResponse.json();
  assert(creationResponse.status === 201 && /^bk_[0-9a-f]{32}$/.test(created.reference), "real public booking creation failed");

  chrome = spawn(chromeBinary, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${chromeProfile}`, "about:blank",
  ], { stdio: "ignore" });
  const devtoolsFile = join(chromeProfile, "DevToolsActivePort");
  const devtools = await waitFor(() => existsSync(devtoolsFile) && readFileSync(devtoolsFile, "utf8").trim(), "headless Chrome DevTools endpoint");
  const debugPort = devtools.split(/\r?\n/, 1)[0];
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === "page");
  assert(target?.webSocketDebuggerUrl, "Chrome exposed no debuggable page");
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: `${origin}/admin/login` });
  await waitFor(() => evaluate(cdp, `document.readyState === "complete" && Boolean(document.getElementById("admin-login-email"))`), "admin login page");
  await setReactField(cdp, "admin-login-email", credentials.email);
  await setReactField(cdp, "admin-login-password", credentials.password);
  await clickButton(cdp, "Se connecter");
  await waitFor(() => evaluate(cdp, `location.pathname === "/admin"`), "real admin login", 45_000);

  await cdp.send("Page.navigate", { url: `${origin}/admin/bookings` });
  await waitFor(() => evaluate(cdp, `location.pathname === "/admin/bookings" && document.querySelector("h1")?.textContent?.trim() === "Calendrier"`), "admin booking calendar", 45_000);
  await openBooking(cdp, initialContact.customerName, bookingDate);
  await clickButton(cdp, "Modifier les coordonnées");
  await waitFor(() => evaluate(cdp, `Boolean(document.getElementById("contact-name"))`), "contact editor");
  await setReactField(cdp, "contact-name", updatedContact.customerName);
  await setReactField(cdp, "contact-email", updatedContact.customerEmail);
  await setReactField(cdp, "contact-phone", updatedContact.customerPhone);
  await setReactField(cdp, "contact-note", updatedContact.customerNote);
  await clickButton(cdp, "Enregistrer les coordonnées");
  await assertDetail(cdp, updatedContact, "server-returned contact detail");

  await evaluate(cdp, `window.__esz099ReloadMarker = true`);
  await cdp.send("Page.reload");
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && window.__esz099ReloadMarker !== true && document.querySelector("h1")?.textContent?.trim() === "Calendrier"`),
    "reloaded booking calendar",
    45_000,
  );
  await openBooking(cdp, updatedContact.customerName, bookingDate);
  await assertDetail(cdp, updatedContact, "persisted contact detail after reload");

  await clickButton(cdp, "Modifier les coordonnées");
  await waitFor(() => evaluate(cdp, `Boolean(document.getElementById("contact-email"))`), "reopened contact editor");
  await setReactField(cdp, "contact-email", "");
  await clickButton(cdp, "Enregistrer les coordonnées");
  await waitFor(
    () => evaluate(cdp, `Boolean(document.getElementById("contact-email-error")?.offsetParent) && Boolean(document.getElementById("contact-name"))`),
    "visible invalid-email error with editor still open",
  );

  const api = createCookieClient(origin);
  const anonymous = await api("/api/auth/session", { headers: { accept: "application/json" } });
  assert(anonymous.response.status === 200 && typeof anonymous.body?.csrfToken === "string", "Node admin session bootstrap failed");
  const login = await api("/api/auth/login", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": anonymous.body.csrfToken },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  assert(login.response.status === 200 && login.body?.authenticated, "Node admin API login failed");
  const query = await api("/api/admin/bookings/query", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ mode: "reference", reference: created.reference }),
  });
  const serverBooking = query.body?.bookings?.[0];
  assert(query.response.status === 200, "final admin booking query failed");
  for (const [field, value] of Object.entries(updatedContact)) {
    assert(serverBooking?.[field] === value, `invalid edit changed server field ${field}`);
  }

  cdp.close();
  process.stdout.write("admin booking contact browser proof: PASS\n");
  process.stdout.write(`booking: ${created.reference}\n`);
  process.stdout.write("valid contact update persisted across reload; invalid email remained client-side\n");
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  await stopProcess(chrome, chrome ? new Promise((resolveExit) => chrome.once("exit", resolveExit)) : null);
  await stopProcess(phpServer, phpServerExit);
  if (mysqlContainer) spawnSync("docker", ["rm", "--force", mysqlContainerName], { stdio: "ignore" });
  rmSync(workRoot, { recursive: true, force: true });
}

if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  process.exit(1);
}
