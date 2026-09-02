#!/usr/bin/env node
/**
 * ESZ-101 — the failure-honest admin auth proof, in a real browser.
 *
 * A disposable MySQL and a real PHP built-in server stand up the whole stack
 * (exactly as browser-admin-booking-contact.mjs does), and headless Chrome
 * drives the real admin UI through three scenarios:
 *
 *  1. Password rotation invalidates an authenticated browser — the operator
 *     CLI changes the password while the browser is signed in; the editor
 *     reloads to the signed-out screen, the old credential no longer signs in
 *     and the new one does.
 *  2. Failed logout UI — a real MySQL trigger makes the server-side session
 *     deletion fail; the admin surface stays put, shows the retryable error
 *     and never claims a signed-out state, and the session keeps authorising
 *     until the retry succeeds once the cause is removed.
 *  3. Successful logout — a clean logout lands on /admin/login, the server row
 *     is gone and the pre-logout cookie can no longer authorise anything.
 *
 * Scenario 2 doubles as the duplicate-free retry proof at the browser level:
 * the retry control is what recovers once the store works again.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeBinary = process.env.ESZTER_ADMIN_AUTH_CHROME ?? "google-chrome";
const workRoot = mkdtempSync(join(tmpdir(), "eszter-admin-auth-"));
const chromeProfile = join(workRoot, "chrome-profile");
const configPath = join(workRoot, "config.php");
const credentialsPath = join(workRoot, "admin.json");
const mysqlContainerName = "esz101_admin_auth_proof";
const databaseName = "esz101_admin_auth_test";
const databaseUsername = "esz101_admin_auth";
const databasePassword = "esz101_admin_auth_only";
const databaseRootPassword = "esz101_admin_auth_root_only";
const sessionCookieName = "eszter_session"; // non-Secure dev build drops __Host-
const rotatedPassword = "esz101-browser-rotated-password";
let mysqlContainer = null;
let phpServer = null;
let phpServerExit = null;
let chrome = null;
let triggerInstalled = false;

function fail(message) {
  throw new Error(`admin auth browser proof: ${message}`);
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

function phpString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** Runs one SQL statement inside the isolated MySQL as root. */
function mysql(sql) {
  return spawnSync(
    "docker",
    ["exec", "-e", `MYSQL_PWD=${databaseRootPassword}`, mysqlContainerName, "mysql", "-uroot", "-N", "-D", databaseName, "-e", sql],
    { encoding: "utf8" },
  );
}

function installLogoutFailureTrigger() {
  const result = mysql(
    "DROP TRIGGER IF EXISTS esz101_logout_failure; CREATE TRIGGER esz101_logout_failure "
      + "BEFORE DELETE ON admin_sessions FOR EACH ROW "
      + "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'esz101 forced logout failure';",
  );
  assert(result.status === 0, `trigger installation failed: ${result.stderr ?? ""}`);
  triggerInstalled = true;
}

function removeLogoutFailureTrigger() {
  if (!mysqlContainer) return;
  mysql("DROP TRIGGER IF EXISTS esz101_logout_failure");
  triggerInstalled = false;
}

function sessionCountFor(email) {
  const result = mysql(
    `SELECT COUNT(*) FROM admin_sessions s JOIN admin_accounts a ON a.id = s.account_id WHERE a.email = '${email}'`,
  );
  assert(result.status === 0, `session count failed: ${result.stderr ?? ""}`);
  return Number.parseInt(result.stdout?.trim() ?? "0", 10);
}

/** Rotates the account password through the real operator CLI. */
function rotatePassword(email, newPassword) {
  const result = spawnSync(
    "php",
    ["php/bin/provision-admin.php", `--config=${configPath}`, `--email=${email}`, "--set-password"],
    { cwd: repoRoot, encoding: "utf8", input: `${newPassword}\n` },
  );
  if (result.status !== 0) fail(`provision-admin failed: ${result.stderr ?? ""}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
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

/** The body text of the current document, trimmed. */
function bodyText(cdp) {
  return evaluate(cdp, "document.body?.innerText ?? ''");
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
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `could not click ${label}`);
}

async function sessionCookie(cdp, origin) {
  const { cookies } = await cdp.send("Network.getCookies", { urls: [origin] });
  const session = cookies?.find((cookie) => cookie.name === sessionCookieName);
  assert(session?.value, "the browser holds no session cookie");
  return session.value;
}

/** Asks PHP, as a raw HTTP client holding one captured cookie, who that id is. */
async function whoIs(origin, sessionId) {
  const response = await fetch(`${origin}/api/auth/session`, {
    headers: { accept: "application/json", cookie: `${sessionCookieName}=${sessionId}` },
  });
  return { status: response.status, body: await response.json() };
}

async function signIn(cdp, origin, email, password) {
  await cdp.send("Page.navigate", { url: `${origin}/admin/login` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && Boolean(document.getElementById("admin-login-email"))`),
    "admin login page",
    45_000,
  );
  await setReactField(cdp, "admin-login-email", email);
  await setReactField(cdp, "admin-login-password", password);
  await clickButton(cdp, "Se connecter");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin" && Boolean(document.querySelector('[data-testid="admin-account-email"]'))`),
    "signed-in admin home",
    45_000,
  );
  const badgeEmail = await evaluate(cdp, `document.querySelector('[data-testid="admin-account-email"]')?.textContent?.trim()`);
  assert(badgeEmail === email, `signed in as ${badgeEmail}, expected ${email}`);
}

async function stopProcess(processHandle, exitPromise) {
  if (!processHandle || !exitPromise || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  processHandle.kill("SIGTERM");
  const stopped = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 3000)),
  ]);
  if (!stopped) processHandle.kill("SIGKILL");
}

async function main() {
  assert(existsSync(join(repoRoot, "front", "out", "index.html")), "front/out is missing; run npm run build first");
  assert(existsSync(join(repoRoot, "php", "vendor", "autoload.php")), "php/vendor is missing; install Composer dependencies first");

  // ── Isolated full stack ───────────────────────────────────────────────────
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
  assert(typeof credentials.email === "string" && typeof credentials.password === "string", "no dev credentials were written");

  const httpPort = await freePort();
  const origin = `http://127.0.0.1:${httpPort}`;
  phpServer = spawn("php", [
    "-S", `127.0.0.1:${httpPort}`, "-t", join(repoRoot, "front", "out"), join(repoRoot, "php", "public", "router.php"),
  ], { cwd: repoRoot, env: { ...process.env, ESZTER_CONFIG: configPath }, stdio: ["ignore", "ignore", "pipe"] });
  phpServerExit = new Promise((resolveExit) => phpServer.once("exit", resolveExit));
  await waitFor(async () => (await fetch(`${origin}/api/health`)).status === 200, "isolated PHP application", 45_000);

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
  await cdp.send("Network.enable");

  // ── Scenario 1: password rotation invalidates the authenticated browser ──
  await signIn(cdp, origin, credentials.email, credentials.password);
  const preRotationId = await sessionCookie(cdp, origin);
  assert(sessionCountFor(credentials.email) === 1, "expected exactly one live session before the rotation");

  const rotationOutput = rotatePassword(credentials.email, rotatedPassword);
  assert(rotationOutput.includes("Signed out of 1 existing session(s)."), `rotation did not revoke the live session: ${rotationOutput}`);

  // Server-side: the captured session id names nothing any more.
  const replayAfterRotation = await whoIs(origin, preRotationId);
  assert(
    replayAfterRotation.status === 200 && replayAfterRotation.body?.authenticated === false,
    "the pre-rotation session id still authorises",
  );

  // Browser-side: the reload lands on the signed-out screen, not the editor.
  await cdp.send("Page.reload");
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && document.body?.innerText?.includes("Connexion requise")`),
    "signed-out screen after rotation",
    45_000,
  );
  const editorGone = await evaluate(cdp, `!document.querySelector('[data-testid="admin-account-email"]')`);
  assert(editorGone, "the editor still renders after the rotation revoked its session");

  // The old password is refused indistinguishably; the new one signs in.
  await evaluate(cdp, `document.querySelector('a') && [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === "Se connecter")?.click()`);
  await waitFor(() => evaluate(cdp, `location.pathname === "/admin/login"`), "login page after rotation", 15_000);
  await setReactField(cdp, "admin-login-email", credentials.email);
  await setReactField(cdp, "admin-login-password", credentials.password);
  await clickButton(cdp, "Se connecter");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/login" && document.body?.innerText?.includes("Adresse email ou mot de passe incorrect.")`),
    "old password refused on the login form",
    30_000,
  );

  await setReactField(cdp, "admin-login-password", rotatedPassword);
  await clickButton(cdp, "Se connecter");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin" && Boolean(document.querySelector('[data-testid="admin-account-email"]'))`),
    "login with the rotated password",
    45_000,
  );
  const preLogoutId = await sessionCookie(cdp, origin);

  // ── Scenario 2: failed logout shows the retryable surface, never a lie ───
  installLogoutFailureTrigger();
  await clickButton(cdp, "Se déconnecter");
  await waitFor(
    () => evaluate(cdp, `document.body?.innerText?.includes("Déconnexion impossible")`),
    "retryable logout failure surface",
    30_000,
  );
  const failureSurface = await evaluate(cdp, `(() => {
    const text = document.body?.innerText ?? "";
    return {
      stillOnAdmin: location.pathname === "/admin",
      retryVisible: [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Réessayer la déconnexion"),
      dismissVisible: [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Continuer à travailler"),
      noFalseSignedOutClaim: text.includes("Ne considérez pas cette session comme révoquée"),
      badgeStillThere: Boolean(document.querySelector('[data-testid="admin-account-email"]')),
    };
  })()`);
  assert(failureSurface.stillOnAdmin, "a failed logout navigated away from the admin surface");
  assert(failureSurface.retryVisible, "the failure surface offers no retry");
  assert(failureSurface.dismissVisible, "the failure surface offers no way back to work");
  assert(failureSurface.noFalseSignedOutClaim, "the failure surface claims a signed-out state");
  assert(failureSurface.badgeStillThere, "the UI dropped the authenticated identity after a failed logout");

  // Server-side the session was not revoked: the captured id still authorises.
  const replayAfterFailedLogout = await whoIs(origin, preLogoutId);
  assert(
    replayAfterFailedLogout.status === 200 && replayAfterFailedLogout.body?.authenticated === true,
    "the session stopped authorising after a logout the server refused",
  );
  assert(sessionCountFor(credentials.email) === 1, "the failed logout deleted the session row");

  // A retry while the cause is still present fails again, honestly.
  await clickButton(cdp, "Réessayer la déconnexion");
  await waitFor(
    () => evaluate(cdp, `document.body?.innerText?.includes("Déconnexion impossible")`),
    "second failure surface after retrying against the broken store",
    30_000,
  );

  // Once the store recovers, the same retry control completes the logout.
  removeLogoutFailureTrigger();
  await clickButton(cdp, "Réessayer la déconnexion");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/login"`),
    "retried logout navigating to the login page",
    30_000,
  );
  const replayAfterRetry = await whoIs(origin, preLogoutId);
  assert(
    replayAfterRetry.status === 200 && replayAfterRetry.body?.authenticated === false,
    "the session id still authorises after the retried logout",
  );

  // ── Scenario 3: a clean logout, server-authoritative ─────────────────────
  await signIn(cdp, origin, credentials.email, rotatedPassword);
  const cleanLogoutId = await sessionCookie(cdp, origin);
  await clickButton(cdp, "Se déconnecter");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/login"`),
    "clean logout navigating to the login page",
    30_000,
  );
  const replayAfterCleanLogout = await whoIs(origin, cleanLogoutId);
  assert(
    replayAfterCleanLogout.status === 200 && replayAfterCleanLogout.body?.authenticated === false,
    "the logged-out session id still authorises",
  );
  assert(sessionCountFor(credentials.email) === 0, "the clean logout left a session row in MySQL");

  cdp.close();
  process.stdout.write("admin auth browser proof: PASS\n");
  process.stdout.write("password rotation signed an authenticated browser out; failed logout stayed honest and retried; clean logout was server-authoritative\n");
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  try {
    removeLogoutFailureTrigger();
  } catch {
    // Container may already be gone; cleanup must not mask the real failure.
  }
  await stopProcess(chrome, chrome ? new Promise((resolveExit) => chrome.once("exit", resolveExit)) : null);
  await stopProcess(phpServer, phpServerExit);
  if (mysqlContainer) spawnSync("docker", ["rm", "--force", mysqlContainerName], { stdio: "ignore" });
  rmSync(workRoot, { recursive: true, force: true });
}

if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  process.exit(1);
}
