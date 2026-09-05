#!/usr/bin/env node
/**
 * Shared full-stack browser fixture for the ESZ-113 project-owned runners
 * (`browser:admin`, `browser:booking`).
 *
 * One real same-origin stack, shaped like the production origin the way
 * `browser:public` (ESZ-104) shapes it: Apache applies the committed
 * generated `.htaccess`, the real PHP front controller mounts at
 * `<docroot>/api/index.php`, the application root is a sibling of the
 * document root, content/media/log/lock paths live in a disposable data root,
 * and an isolated MySQL 8.4 container holds the real schema. Nothing is
 * mocked — PHP, MySQL, migrations, the development provisioning CLI, the
 * browser, the DOM. Nothing ever leaves 127.0.0.1.
 *
 * Every resource is disposable and is removed by `cleanup()` on success,
 * failure and interruption: containers, network, Chrome profile, credentials
 * and the whole temporary data root. The persistent `eszter_dev` deployment
 * (compose.dev.yml) is never created, read or reset.
 *
 * Re-exported here are the CDP/browser helpers the two runners share (and
 * that every focused browser runner currently duplicates): the WebSocket CDP
 * client, DOM evaluation, React-safe field editing, button/anchor clicking,
 * viewport emulation, real keyboard input events, and the anonymous/admin
 * session cookie helpers.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export { repoRoot };

export function phpString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function ensureDir(path, mode = 0o777) {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
}

/** Builds a gate-specific `fail`/`assert` pair so every error names its gate. */
export function makeProof(gate) {
  const fail = (message) => {
    throw new Error(`${gate} proof: ${message}`);
  };
  const assert = (condition, message) => {
    if (!condition) fail(message);
  };
  return { fail, assert };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
    input: options.input,
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

export function runIgnoringExit(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

export async function waitFor(check, description, timeoutMs = 45_000) {
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
  throw new Error(
    `${description} did not become ready${lastError ? `: ${lastError.message}` : ""}`,
  );
}

export async function freePort() {
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

export function parisToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function addParisDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The exact label prefix the admin calendar's day cells carry
 * (formatParisDate + ", "): e.g. "mardi 1 septembre 2026, ".
 */
export function parisDayCellPrefix(date) {
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

/** The short French label the public booking date grid renders ("sam. 5 sept."). */
export function parisShortDateLabel(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function stopProcessQuietly(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  processHandle.kill("SIGTERM");
  setTimeout(() => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      processHandle.kill("SIGKILL");
    }
  }, 3000);
}

// ── CDP ────────────────────────────────────────────────────────────────────

export class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener("open", resolveReady, { once: true });
      this.socket.addEventListener(
        "error",
        () => rejectReady(new Error("Chrome DevTools connection failed")),
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
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

export async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? "browser evaluation failed",
    );
  }
  return result.result.value;
}

/** React-safe text edit: the native setter + a bubbling input event. */
export async function setReactInput(cdp, id, value) {
  const changed = await evaluate(
    cdp,
    `(() => {
      const input = document.getElementById(${JSON.stringify(id)});
      if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
  if (!changed) throw new Error(`could not edit #${id}`);
  await waitFor(
    () => evaluate(cdp, `document.getElementById(${JSON.stringify(id)})?.value === ${JSON.stringify(value)}`),
    `#${id} edit`,
  );
}

/** Clicks a checkbox/radio the way a user does (trusted activation). */
export async function clickCheckbox(cdp, id) {
  const clicked = await evaluate(cdp, `(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    if (!(input instanceof HTMLInputElement)) return false;
    input.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`could not click #${id}`);
}

/** Clicks the one button whose trimmed text is exactly `label`. */
export async function clickButton(cdp, label) {
  const clicked = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`could not click ${label}`);
}

/** Clicks the first enabled button whose trimmed text contains `text`. */
export async function clickButtonContaining(cdp, text) {
  const clicked = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}) && !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`could not click a button containing ${text}`);
}

/** Clicks a button matched by an attribute selector predicate, returns true when found. */
export async function clickButtonWhere(cdp, predicateSource) {
  return evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => (${predicateSource}));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
}

export async function setViewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

export async function navigateAndWait(cdp, url, description, readiness) {
  await cdp.send("Page.navigate", { url });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && (${readiness})`),
    description,
  );
}

// ── Real keyboard input (Input domain, trusted events) ─────────────────────

async function dispatchKey(cdp, type, params) {
  await cdp.send("Input.dispatchKeyEvent", { type, ...params });
}

async function pressKey(cdp, key, code, keyCode, text) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await dispatchKey(cdp, "rawKeyDown", { ...base });
  if (text !== undefined) await dispatchKey(cdp, "char", { ...base, text });
  await dispatchKey(cdp, "keyUp", { ...base });
}

export function pressTab(cdp) {
  return pressKey(cdp, "Tab", "Tab", 9);
}

// Empirically required by headless Chrome: a focused submit button only
// activates on Enter when the rawKeyDown is followed by a `char` event
// carrying "\r" — rawKeyDown + keyUp alone is swallowed.
export function pressEnter(cdp) {
  return pressKey(cdp, "Enter", "Enter", 13, "\r");
}

export function pressEscape(cdp) {
  return pressKey(cdp, "Escape", "Escape", 27);
}

const SYMBOL_KEY_CODES = {
  ".": ["Period", 190],
  "@": ["Digit2", 50],
  "-": ["Minus", 189],
  "_": ["Minus", 189],
  "+": ["Equal", 187],
  "/": ["Slash", 191],
  ":": ["Semicolon", 186],
  "!": ["Digit1", 49],
  "#": ["Digit3", 51],
  "$": ["Digit4", 52],
  "%": ["Digit5", 53],
  "&": ["Digit7", 55],
  "(": ["Digit9", 57],
  ")": ["Digit0", 48],
  "=": ["Equal", 187],
  "?": ["Slash", 191],
  " ": ["Space", 32],
};

function keyEventFor(char) {
  if (/^[A-Z]$/.test(char)) return [`Key${char}`, char.charCodeAt(0)];
  if (/^[a-z]$/.test(char)) return [`Key${char.toUpperCase()}`, char.toUpperCase().charCodeAt(0)];
  if (/^[0-9]$/.test(char)) return [`Digit${char}`, char.charCodeAt(0)];
  return SYMBOL_KEY_CODES[char] ?? ["Period", 190];
}

/** Types text into the currently focused field through real key events. */
export async function typeText(cdp, text) {
  for (const char of text) {
    const [code, vk] = keyEventFor(char);
    await dispatchKey(cdp, "char", {
      key: char,
      code,
      text: char,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

/** Returns { tag, id, label, text } of the currently focused element. */
export async function activeElement(cdp) {
  return evaluate(cdp, `(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { tag: "body" };
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      text: (element.textContent ?? "").trim().slice(0, 120) || null,
      ariaLabel: element.getAttribute("aria-label"),
    };
  })()`);
}

// ── Session helpers ────────────────────────────────────────────────────────

export async function sessionCookie(cdp, origin, cookieName) {
  const { cookies } = await cdp.send("Network.getCookies", { urls: [origin] });
  const session = cookies?.find((cookie) => cookie.name === cookieName);
  if (!session?.value) throw new Error("the browser holds no session cookie");
  return `${session.name}=${session.value}`;
}

export async function adminSession(cdp, origin, cookieName, csrfHeader) {
  const cookie = await sessionCookie(cdp, origin, cookieName);
  const response = await fetch(`${origin}/api/auth/session`, {
    headers: { accept: "application/json", cookie },
  });
  const body = await response.json();
  if (!(response.status === 200 && body.authenticated === true)) {
    throw new Error("captured cookie no longer authenticates");
  }
  return { cookie, csrfToken: body.csrfToken };
}

/**
 * Signs in through the real login form. The login form carries an
 * anonymous-session CSRF token; a rotation race is answered by the form with
 * a "session renewed, resend" message and a transient stack 500 is equally
 * retryable, so resend until the submit lands, bounded so a genuine
 * credential failure still surfaces.
 */
export async function signIn(cdp, origin, email, password, click = clickButton) {
  await cdp.send("Page.navigate", { url: `${origin}/admin/login` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && Boolean(document.getElementById("admin-login-email"))`),
    "admin login page",
  );
  for (let attempt = 0; attempt < 4; attempt++) {
    await setReactInput(cdp, "admin-login-email", email);
    await setReactInput(cdp, "admin-login-password", password);
    await click(cdp, "Se connecter");
    let outcome = null;
    try {
      outcome = await waitFor(
        () => evaluate(cdp, `(() => {
          if (location.pathname === "/admin" && document.querySelector('[data-testid="admin-account-email"]')) return "in";
          const text = document.body?.innerText ?? "";
          if (location.pathname === "/admin/login" && text.includes("La session de sécurité a été renouvelée")) return "renewed";
          if (location.pathname === "/admin/login" && text.includes("Adresse email ou mot de passe incorrect")) return "refused";
          if (location.pathname === "/admin/login" && text.includes("pas pu traiter la demande")) return "server-error";
          return null;
        })()`),
        "login submit outcome",
        45_000,
      );
    } catch (outcomeError) {
      const pageState = await evaluate(cdp, `JSON.stringify({ path: location.pathname, bodyHead: (document.body?.innerText ?? "").slice(0, 300) })`);
      throw new Error(`${outcomeError.message}; page state: ${pageState}`);
    }
    if (outcome === "in") return;
    if (outcome === "renewed" || outcome === "server-error") continue;
    const pageState = await evaluate(cdp, `JSON.stringify({ path: location.pathname, bodyHead: (document.body?.innerText ?? "").slice(0, 300) })`);
    throw new Error(`login refused; page state: ${pageState}`);
  }
  throw new Error("login did not complete after repeated resends");
}

// ── Full-stack fixture ─────────────────────────────────────────────────────

/**
 * Starts the disposable Apache/PHP/MySQL stack for one gate.
 *
 * @param {object} options
 * @param {string} options.gate       gate id, for error messages
 * @param {string} options.tag        short unique resource prefix (containers/network/DB)
 * @param {string} [options.apacheImage] docker image running Apache + PHP + pdo_mysql + gd
 * @param {string} [options.chromeBinary] chrome binary (default google-chrome)
 * @returns {Promise<object>} stack handle — see fields below
 */
export async function startApacheStack({ gate, tag, apacheImage = "esz104-apache:local", chromeBinary = "google-chrome" }) {
  const { fail, assert } = makeProof(gate);
  const shortTag = tag.replace(/[^a-z0-9]/g, "");
  const workRoot = mkdtempSync(join(tmpdir(), `eszter-${shortTag}-`));
  chmodSync(workRoot, 0o777);
  const documentRoot = join(workRoot, "public_html");
  const configPath = join(workRoot, "config.php");
  const credentialsDir = join(workRoot, "credentials");
  const credentialsPath = join(credentialsDir, "admin.json");
  const mysqlName = `${shortTag}_mysql`;
  const apacheName = `${shortTag}_apache`;
  const networkName = `${shortTag}_net`;
  const databaseName = `${shortTag}_proof`;
  const databaseUsername = `${shortTag}_proof`;
  const databasePassword = `${shortTag}_db_only`;
  const databaseRootPassword = `${shortTag}_root_only`;

  assert(existsSync(join(repoRoot, "front", "out", "index.html")), "front/out is missing; run npm run build first");
  assert(existsSync(join(repoRoot, "php", "vendor", "autoload.php")), "php/vendor is missing; install Composer dependencies first");
  assert(existsSync(join(repoRoot, "php", "public", ".htaccess")), "php/public/.htaccess is missing");

  // The Apache image is built once per machine (php:8.4-apache lacks
  // pdo_mysql/gd); every browser gate shares it.
  if (!runIgnoringExit("docker", ["image", "inspect", apacheImage])) {
    process.stdout.write("building the local Apache image (pdo_mysql + gd)…\n");
    const build = spawnSync(
      "docker",
      ["build", "-t", apacheImage, "-"],
      { input: `FROM php:8.4-apache
RUN apt-get update && apt-get install -y --no-install-recommends gcc make libpng-dev libjpeg62-turbo-dev libwebp-dev zlib1g-dev \\
    && docker-php-ext-configure gd --with-jpeg --with-webp \\
    && docker-php-ext-install -j2 pdo_mysql gd \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*
`, encoding: "utf8" },
    );
    if (build.status !== 0) fail(`could not build ${apacheImage}: ${build.stderr ?? build.stdout}`);
  }

  // ── Layout the disposable deployment ────────────────────────────────────
  for (const dir of [
    join(workRoot, "data", "content"), join(workRoot, "var", "tmp"),
    join(workRoot, "var", "locks"), join(workRoot, "var", "log"),
    join(workRoot, "media-originals"),
  ]) {
    ensureDir(dir);
  }
  ensureDir(credentialsDir);
  ensureDir(documentRoot);
  ensureDir(join(documentRoot, "media"));
  cpSync(join(repoRoot, "front", "out"), documentRoot, { recursive: true });
  cpSync(join(repoRoot, "php", "public", ".htaccess"), join(documentRoot, ".htaccess"));
  cpSync(join(repoRoot, "php", "public", "media", ".htaccess"), join(documentRoot, "media", ".htaccess"));
  ensureDir(join(documentRoot, "api"));
  cpSync(join(repoRoot, "php", "public", "api", "index.php"), join(documentRoot, "api", "index.php"));

  const containerRoot = `/srv/${shortTag}`;
  writeFileSync(
    configPath,
    `<?php
declare(strict_types=1);
return [
  'environment' => 'development',
  'logLevel' => 'debug',
  'paths' => [
    'content' => ${phpString(`${containerRoot}/data/content`)},
    'tmp' => ${phpString(`${containerRoot}/var/tmp`)},
    'locks' => ${phpString(`${containerRoot}/var/locks`)},
    'log' => ${phpString(`${containerRoot}/var/log`)},
    'contracts' => ${phpString("/srv/eszter-contracts")},
    'mediaOriginals' => ${phpString(`${containerRoot}/media-originals`)},
    'public' => ${phpString("/var/www/html")},
  ],
  'database' => [
    'dsn' => 'mysql:host=${mysqlName};port=3306;dbname=${databaseName};charset=utf8mb4',
    'username' => '${databaseUsername}',
    'password' => '${databasePassword}',
    'connectTimeoutSeconds' => 5,
  ],
  'session' => ['cookieSecure' => false, 'idleTimeoutSeconds' => 3600, 'absoluteTimeoutSeconds' => 43200],
];
`,
    { mode: 0o644 },
  );

  run("docker", ["network", "create", networkName]);
  let mysqlContainer = null;
  let apacheContainer = null;
  try {
    mysqlContainer = run("docker", [
      "run", "--detach", "--rm", "--name", mysqlName, "--network", networkName,
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
    await waitFor(
      () => runIgnoringExit("docker", ["exec", mysqlName, "sh", "-lc",
        'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent']),
      "isolated MySQL",
      60_000,
    );
    runIgnoringExit("docker", ["exec", mysqlName, "sh", "-lc",
      'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SET GLOBAL log_bin_trust_function_creators=1;"']);

    apacheContainer = run("docker", [
      "run", "--detach", "--rm", "--name", apacheName, "--network", networkName,
      "--publish", "127.0.0.1::80",
      "--volume", `${workRoot}:${containerRoot}`,
      "--volume", `${credentialsDir}:/srv/${shortTag}-creds`,
      // Hetzner layout: the app root is a sibling of the docroot's parent
      // (`/var/www/app`), which is how the front controller mounts.
      "--volume", `${repoRoot}/php:/var/www/app:ro`,
      "--volume", `${repoRoot}/contracts/generated:/srv/eszter-contracts:ro`,
      "--volume", `${documentRoot}:/var/www/html`,
      "--env", `ESZTER_CONFIG=${containerRoot}/config.php`,
      apacheImage,
      "sh", "-c",
      "a2enmod headers rewrite >/dev/null 2>&1 && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf && exec apache2-foreground",
    ]);

    const portOutput = await waitFor(
      () => run("docker", ["port", apacheName, "80/tcp"]),
      "Apache port publication",
    );
    const apachePort = /:(\d+)$/.exec(portOutput)?.[1];
    assert(apachePort, `could not parse Apache port from ${portOutput}`);
    const origin = `http://127.0.0.1:${apachePort}`;
    try {
      await waitFor(async () => (await fetch(`${origin}/api/health`)).status === 200, "Apache + PHP front controller", 60_000);
    } catch (readinessError) {
      let apacheLogs = "";
      try {
        apacheLogs = run("docker", ["logs", apacheName]);
      } catch {
        apacheLogs = "(no apache logs available)";
      }
      throw new Error(`${readinessError.message}\n--- apache logs ---\n${apacheLogs}`);
    }

    // Provision the real schema and the development fixtures inside the
    // container, then hand every runtime file to www-data (the user Apache's
    // PHP runs as) so a root-owned lock or seed can never fail a request.
    run("docker", ["exec", apacheName, "php", "/var/www/app/bin/migrate.php", `--config=${containerRoot}/config.php`]);
    run("docker", ["exec", apacheName, "php", "/var/www/app/bin/bootstrap-development.php",
      `--config=${containerRoot}/config.php`, `--credentials-file=/srv/${shortTag}-creds/admin.json`]);
    run("docker", ["exec", apacheName, "sh", "-c",
      `chown -R www-data:www-data ${containerRoot}/data ${containerRoot}/var ${containerRoot}/media-originals && chmod 0644 /srv/${shortTag}-creds/admin.json && chmod 0755 /srv/${shortTag}-creds`]);
    const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert(typeof credentials.email === "string" && typeof credentials.password === "string", "no dev credentials were written");

    /** Runs one SQL statement as root against the isolated database. */
    const mysqlRaw = (sql) => spawnSync(
      "docker",
      ["exec", "-e", `MYSQL_PWD=${databaseRootPassword}`, mysqlName, "mysql", "-uroot", "-N", "-B", "-D", databaseName, "-e", sql],
      { encoding: "utf8" },
    );
    const mysqlExec = (sql) => {
      const result = mysqlRaw(sql);
      if (result.status !== 0) {
        throw new Error(`mysql query failed: ${result.stderr?.trim() || sql}`);
      }
      return result.stdout?.trim() ?? "";
    };
    const mysqlJson = (sql) => {
      const output = mysqlExec(sql);
      if (!output) return null;
      return JSON.parse(output);
    };

    return {
      origin,
      credentials,
      workRoot,
      documentRoot,
      mysqlName,
      apacheName,
      networkName,
      databaseName,
      containerRoot,
      chromeBinary,
      apacheExec: (args, options = {}) => run("docker", ["exec", apacheName, ...args], options),
      mysqlExec,
      mysqlJson,
      mysqlRaw,
      cleanup: () => {
        if (apacheContainer) {
          try {
            runIgnoringExit("docker", ["exec", apacheName, "sh", "-c", `rm -rf ${containerRoot} /srv/${shortTag}-creds /var/www/html`]);
          } catch {
            // container already gone
          }
        }
        if (apacheContainer) runIgnoringExit("docker", ["rm", "--force", apacheName]);
        if (mysqlContainer) runIgnoringExit("docker", ["rm", "--force", mysqlName]);
        runIgnoringExit("docker", ["network", "rm", networkName]);
        rmSync(workRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (apacheContainer) runIgnoringExit("docker", ["rm", "--force", apacheName]);
    if (mysqlContainer) runIgnoringExit("docker", ["rm", "--force", mysqlName]);
    runIgnoringExit("docker", ["network", "rm", networkName]);
    rmSync(workRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Launches headless Chrome and returns { chrome, cdp } on the first page. */
export async function launchChrome(chromeBinary, profileDir) {
  const chrome = spawn(
    chromeBinary,
    [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--ignore-certificate-errors",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "about:blank",
    ],
    { stdio: "ignore" },
  );
  const devtoolsFile = join(profileDir, "DevToolsActivePort");
  const devtools = await waitFor(
    () => existsSync(devtoolsFile) && readFileSync(devtoolsFile, "utf8").trim(),
    "headless Chrome DevTools endpoint",
  );
  const debugPort = devtools.split(/\r?\n/, 1)[0];
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome exposed no debuggable page");
  return { chrome, cdp: new CdpClient(target.webSocketDebuggerUrl), debugPort };
}

/** Opens an additional browser tab and returns its CDP client. */
export async function openTab(debugPort) {
  const created = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
  if (!created?.webSocketDebuggerUrl) throw new Error("Chrome created no second tab");
  return new CdpClient(created.webSocketDebuggerUrl);
}

/** URL-decodes a query value from a location.search string. */
export function searchParam(search, name) {
  return new URLSearchParams(search).get(name);
}
