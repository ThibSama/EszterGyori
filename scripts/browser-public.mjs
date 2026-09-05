#!/usr/bin/env node
/**
 * ESZ-104 — the project-owned `browser:public` runner, under Apache.
 *
 * The gate used to be NOT RUN because no project-owned runner covered the
 * broader public scenario it declares. This is that runner: it stands up the
 * whole public stack the way a deployed origin is shaped — Apache applying the
 * committed generated `.htaccess`, the real PHP front controller, an isolated
 * MySQL — and proves, in a real headless browser and only against local
 * fixtures:
 *
 *  - the public page renders the published content (hero copy, managed media,
 *    gallery and Instagram links exactly as the envelope declares them);
 *  - navigation and deep links land below the fixed navbar;
 *  - gallery and Instagram links resolve as declared (attributes and targets,
 *    never the public Internet);
 *  - layout holds at phone/tablet/desktop widths, with no horizontal overflow;
 *  - ESZ-104's image policy under the committed CSP `img-src 'self' https:`:
 *    a same-origin managed image loads and decodes with no CSP violation, a
 *    cross-origin HTTPS image from a local TLS fixture loads and decodes
 *    (scheme-wide `https:`), an HTTP media source is refused as
 *    contract-invalid through the real draft-save envelope before any
 *    publication, and an intentionally injected HTTP `<img>` is CSP-blocked
 *    (negative control) while the same HTTP fixture origin demonstrably serves
 *    images when reached outside the page.
 *
 * Everything is disposable: a scratch document root, an isolated MySQL, a
 * self-signed loopback TLS fixture with the browser trust bypass scoped to
 * this run's Chrome profile, and a plain HTTP fixture server. No request ever
 * leaves 127.0.0.1. All containers, processes, profiles and temp files are
 * removed on every exit path.
 *
 * Requires, like the other browser gates: docker, google-chrome, a built
 * `front/out`, and `php/vendor`. The Apache image is `php:8.4-apache`
 * extended with pdo_mysql and gd (the base image ships neither); the runner
 * builds it once as `esz104-apache:local` when it is absent.
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
import http from "node:http";
import https from "node:https";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeBinary = process.env.ESZTER_PUBLIC_CHROME ?? "google-chrome";
const apacheImage = "esz104-apache:local";
const workRoot = mkdtempSync(join(tmpdir(), "eszter-public-"));
// The Apache container's www-data must be able to reach the shared data dir
// and config through this root (the container is a different user than this
// process), so the disposable root is world-traversable.
chmodSync(workRoot, 0o777);
const chromeProfile = join(workRoot, "chrome-profile");
const documentRoot = join(workRoot, "public_html");
const configPath = join(workRoot, "config.php");
const credentialsDir = join(workRoot, "credentials");
const credentialsPath = join(credentialsDir, "admin.json");
const proofImagePath = join(workRoot, "proof.png");
const certPath = join(workRoot, "cert.pem");
const keyPath = join(workRoot, "key.pem");
const mysqlName = "esz104_public_mysql";
const apacheName = "esz104_public_apache";
const networkName = "esz104_public_net";
const databaseName = "esz104_public_proof";
const databaseUsername = "esz104_public";
const databasePassword = "esz104_public_only";
const databaseRootPassword = "esz104_public_root_only";
const sessionCookieName = "eszter_session"; // non-Secure dev build drops __Host-
const csrfHeader = "x-csrf-token";
const probePath = "/__esz104_public_csp_probe.html";
const PROBE_TITLE = "ESZ-104 CSP image probe";
const ANCHOR_TARGETS = ["prestations", "parcours", "realisations", "a-propos", "contact"];

let mysqlContainer = null;
let apacheContainer = null;
let chrome = null;
let tlsServer = null;
let plainServer = null;
const plainHits = new Map(); // path -> request count on the plain HTTP fixture

function fail(message) {
  throw new Error(`browser:public proof: ${message}`);
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
    input: options.input,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout?.trim() ?? "";
}

function runIgnoringExit(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function phpString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function ensureDir(path, mode = 0o777) {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
}

async function waitFor(check, description, timeoutMs = 45_000) {
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

function policyDirective(policy, name) {
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/);
    if (tokens[0] === name) return tokens.slice(1);
  }
  return null;
}

function responseHeader(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

function stopProcessQuietly(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  processHandle.kill("SIGTERM");
  setTimeout(() => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      processHandle.kill("SIGKILL");
    }
  }, 3000);
}

async function stopServer(server) {
  if (!server) return;
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

class CdpClient {
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

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    fail(result.exceptionDetails.exception?.description ?? "browser evaluation failed");
  }
  return result.result.value;
}

async function setReactInput(cdp, id, value) {
  const changed = await evaluate(
    cdp,
    `(() => {
      const input = document.getElementById(${JSON.stringify(id)});
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
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

async function clickAnchor(cdp, text) {
  // A real mouse click: synthetic `element.click()` changes the hash but the
  // browser suppresses the scroll-to-fragment without a user activation, so
  // the deep-link landing could never be asserted honestly from it. The CDP
  // input events below are genuine activations — the click lands on the
  // visible anchor (the fixed desktop navbar) at its real coordinates.
  const target = await waitFor(
    () => evaluate(cdp, `(() => {
      const anchors = [...document.querySelectorAll("a")].filter((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
      const visible = anchors.find((anchor) => anchor.getBoundingClientRect().width > 0 && anchor.getBoundingClientRect().height > 0);
      if (!visible) return null;
      const rect = visible.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`),
    `visible ${text} link`,
    15_000,
  );
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
}

async function signIn(cdp, origin, email, password) {
  await cdp.send("Page.navigate", { url: `${origin}/admin/login` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && Boolean(document.getElementById("admin-login-email"))`),
    "admin login page",
  );
  await setReactInput(cdp, "admin-login-email", email);
  await setReactInput(cdp, "admin-login-password", password);

  // The login form carries an anonymous-session CSRF token. A rotation race
  // (the server renewing the token between form load and submit) is answered
  // by the form with a "session renewed, resend" message; a transient stack
  // 500 answers with the generic server-error message and is equally retryable
  // on a just-booted disposable stack. Resend until the submit lands, bounded
  // so a genuine credential failure still surfaces.
  let pageState = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    // A session-renewal resend may reset the form, so re-enter the fields
    // before every submit (idempotent on the first pass).
    await setReactInput(cdp, "admin-login-email", email);
    await setReactInput(cdp, "admin-login-password", password);
    await clickButton(cdp, "Se connecter");
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
      pageState = await evaluate(cdp, `JSON.stringify({ path: location.pathname, bodyHead: (document.body?.innerText ?? "").slice(0, 300) })`);
      throw new Error(`${outcomeError.message}; page state: ${pageState}`);
    }
    if (outcome === "in") return;
    if (outcome === "renewed" || outcome === "server-error") continue;
    pageState = await evaluate(cdp, `JSON.stringify({ path: location.pathname, bodyHead: (document.body?.innerText ?? "").slice(0, 300) })`);
    throw new Error(`login refused; page state: ${pageState}`);
  }
  pageState = await evaluate(cdp, `JSON.stringify({ path: location.pathname, bodyHead: (document.body?.innerText ?? "").slice(0, 300) })`);
  throw new Error(`login did not complete after repeated resends; page state: ${pageState}`);
}

async function sessionCookie(cdp, origin) {
  const { cookies } = await cdp.send("Network.getCookies", { urls: [origin] });
  const session = cookies?.find((cookie) => cookie.name === sessionCookieName);
  assert(session?.value, "the browser holds no session cookie");
  return `${session.name}=${session.value}`;
}

async function adminSession(cdp, origin) {
  const cookie = await sessionCookie(cdp, origin);
  const response = await fetch(`${origin}/api/auth/session`, {
    headers: { accept: "application/json", cookie },
  });
  const body = await response.json();
  assert(response.status === 200 && body.authenticated === true, "captured cookie no longer authenticates");
  return { cookie, csrfToken: body.csrfToken };
}

/** A full envelope round trip through the real draft surface, with assertions. */
async function draftPut(origin, { cookie, csrfToken }, expectedRevision, content) {
  const response = await fetch(`${origin}/api/admin/content/draft`, {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      [csrfHeader]: csrfToken,
    },
    body: JSON.stringify({ expectedRevision, content }),
  });
  return { status: response.status, body: await response.json() };
}

async function draftGet(origin, cookie) {
  const response = await fetch(`${origin}/api/admin/content/draft`, {
    headers: { accept: "application/json", cookie },
  });
  assert(response.status === 200, `draft GET returned ${response.status}`);
  return response.json();
}

function fixtureServer(body, hits) {
  return (request, response) => {
    const path = request.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    response.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
    });
    response.end(body);
  };
}

async function launchChrome() {
  chrome = spawn(
    chromeBinary,
    [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--ignore-certificate-errors",
      "--remote-debugging-port=0", `--user-data-dir=${chromeProfile}`, "about:blank",
    ],
    { stdio: "ignore" },
  );
  const devtoolsFile = join(chromeProfile, "DevToolsActivePort");
  const devtools = await waitFor(
    () => existsSync(devtoolsFile) && readFileSync(devtoolsFile, "utf8").trim(),
    "headless Chrome DevTools endpoint",
  );
  const debugPort = devtools.split(/\r?\n/, 1)[0];
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === "page");
  assert(target?.webSocketDebuggerUrl, "Chrome exposed no debuggable page");
  return new CdpClient(target.webSocketDebuggerUrl);
}

function setCspViolationListenerSource() {
  return `(() => {
    window.__esz104Violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__esz104Violations.push({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        disposition: event.disposition,
        sourceFile: event.sourceFile ?? null,
        lineNumber: event.lineNumber ?? null,
        columnNumber: event.columnNumber ?? null,
        sample: event.sample ?? null,
      });
    });
  })();`;
}

async function navigateAndWait(cdp, url, description, readiness) {
  await cdp.send("Page.navigate", { url });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && (${readiness})`),
    description,
  );
}

async function decodeImage(cdp, selector, description) {
  const decoded = await waitFor(
    () => evaluate(cdp, `(async () => {
      const image = document.querySelector(${JSON.stringify(selector)});
      if (!image) return null;
      image.scrollIntoView({ block: "center" });
      if (!image.complete) {
        await new Promise((resolveImage) => {
          image.addEventListener("load", resolveImage, { once: true });
          image.addEventListener("error", resolveImage, { once: true });
          window.setTimeout(resolveImage, 5000);
        });
      }
      if (image.naturalWidth < 1 || image.naturalHeight < 1) return null;
      return { src: image.getAttribute("src"), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
    })()`, true),
    description,
  );
  return decoded;
}

/**
 * Decodes the field preview for one media input.
 *
 * The editor's own preview is an `<img>` whose src equals the field's current
 * value and which is not one of the media-library thumbnails (those render
 * inside `<button>`s in the panel). The live site preview lives in a separate
 * iframe document, so no top-document image can belong to it.
 */
async function decodeEditorPreview(cdp, inputId, description) {
  const decoded = await waitFor(
    () => evaluate(cdp, `(async () => {
      const input = document.getElementById(${JSON.stringify(inputId)});
      const value = input?.value ?? "";
      if (!value) return null;
      const candidates = [...document.querySelectorAll("img")]
        .filter((image) => image.getAttribute("src") === value)
        .filter((image) => !image.closest("button"));
      const previewImage = candidates[candidates.length - 1] ?? null;
      if (!previewImage) return null;
      previewImage.scrollIntoView({ block: "center" });
      if (!previewImage.complete) {
        await new Promise((resolveImage) => {
          previewImage.addEventListener("load", resolveImage, { once: true });
          previewImage.addEventListener("error", resolveImage, { once: true });
          window.setTimeout(resolveImage, 5000);
        });
      }
      if (previewImage.naturalWidth < 1 || previewImage.naturalHeight < 1) return null;
      return { src: previewImage.getAttribute("src"), naturalWidth: previewImage.naturalWidth };
    })()`, true),
    description,
  );
  return decoded;
}

async function anchorLandsBelowNav(cdp, targetId) {
  let lastState = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, `(() => {
      const section = document.getElementById(${JSON.stringify(targetId)});
      const nav = document.querySelector("nav[aria-label='Navigation principale']");
      if (!section || !nav) return null;
      const sectionTop = section.getBoundingClientRect().top;
      const navBottom = nav.getBoundingClientRect().bottom;
      return { sectionTop, navBottom, hash: location.hash, scrollY };
    })()`);
    if (state) {
      lastState = state;
      if (Math.abs(state.sectionTop - 96) <= 8) {
        assert(
          state.sectionTop >= state.navBottom - 1,
          `#${targetId} landed above the navbar bottom (section ${state.sectionTop}px, navbar bottom ${state.navBottom}px)`,
        );
        return state;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  fail(
    `#${targetId} landing below the fixed navbar did not settle; last state: ${JSON.stringify(lastState)}`,
  );
}

async function setViewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

function esc(value) {
  return JSON.stringify(value);
}

/**
 * The image-policy violations that count for ESZ-104.
 *
 * A page can legitimately record a `script-src` violation that is not image
 * related: the bundled validator probes for `Function(...)` once to decide
 * whether to use its JIT path, and the policy deliberately has no
 * `'unsafe-eval'`, so the probe is blocked and the validator falls back to its
 * interpreter. That is the policy working — a script-src refusal, gracefully
 * handled — and it says nothing about images. Every ESZ-104 assertion about
 * "no CSP violation" therefore means no `img-src` violation: nothing in the
 * image source list may be refused, because `img-src 'self' https:` is the
 * directive this gate exists to prove.
 */
function imageViolations(violations) {
  return (violations ?? []).filter((violation) => violation.effectiveDirective === "img-src");
}

async function main() {
  assert(existsSync(join(repoRoot, "front", "out", "index.html")), "front/out is missing; run npm run build first");
  assert(existsSync(join(repoRoot, "php", "vendor", "autoload.php")), "php/vendor is missing; install Composer dependencies first");
  assert(existsSync(join(repoRoot, "php", "public", ".htaccess")), "php/public/.htaccess is missing");

  // ── Build the Apache image once (php:8.4-apache lacks pdo_mysql/gd) ──────
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

  // ── Fixture image bytes (a real PNG, generated locally) ───────────────────
  run("php", [
    "-r",
    '$image=imagecreatetruecolor(96,64);$background=imagecolorallocate($image,99,114,108);$accent=imagecolorallocate($image,238,226,215);imagefilledrectangle($image,0,0,95,63,$background);imagefilledellipse($image,48,32,54,38,$accent);imagepng($image,$argv[1]);',
    proofImagePath,
  ]);
  const proofImage = readFileSync(proofImagePath);

  // ── Layout the disposable deployment ──────────────────────────────────────
  for (const dir of [
    "data/content", "var/tmp", "var/locks", "var/log", "media-originals",
  ]) {
    ensureDir(join(workRoot, dir));
  }
  // The credentials file gets its own directory: the provisioning CLI enforces
  // mode 0700 on the credentials directory (fail-closed), and it must never
  // chmod the shared data root, which Apache's www-data needs to traverse.
  ensureDir(credentialsDir);
  ensureDir(documentRoot);
  ensureDir(join(documentRoot, "media"));
  cpSync(join(repoRoot, "front", "out"), documentRoot, { recursive: true });
  cpSync(join(repoRoot, "php", "public", ".htaccess"), join(documentRoot, ".htaccess"));
  cpSync(join(repoRoot, "php", "public", "media", ".htaccess"), join(documentRoot, "media", ".htaccess"));
  ensureDir(join(documentRoot, "api"));
  cpSync(join(repoRoot, "php", "public", "api", "index.php"), join(documentRoot, "api", "index.php"));

  writeFileSync(
    configPath,
    `<?php\ndeclare(strict_types=1);\nreturn [
  'environment' => 'development',
  'logLevel' => 'debug',
  'paths' => [
    'content' => ${phpString("/srv/esz104/data/content")},
    'tmp' => ${phpString("/srv/esz104/var/tmp")},
    'locks' => ${phpString("/srv/esz104/var/locks")},
    'log' => ${phpString("/srv/esz104/var/log")},
    'contracts' => ${phpString("/srv/eszter-contracts")},
    'mediaOriginals' => ${phpString("/srv/esz104/media-originals")},
    'public' => ${phpString("/var/www/html")},
  ],
  'database' => [
    'dsn' => 'mysql:host=${mysqlName};port=3306;dbname=${databaseName};charset=utf8mb4',
    'username' => '${databaseUsername}',
    'password' => '${databasePassword}',
    'connectTimeoutSeconds' => 5,
  ],
  'session' => ['cookieSecure' => false, 'idleTimeoutSeconds' => 3600, 'absoluteTimeoutSeconds' => 43200],
];\n`,
    { mode: 0o644 },
  );

  run("docker", ["network", "create", networkName]);
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
    "--volume", `${workRoot}:/srv/esz104`,
    "--volume", `${credentialsDir}:/srv/esz104-creds`,
    // The Hetzner layout detection in public/api/index.php looks for the app
    // root as a sibling of the docroot's parent (`/var/www/app`), because the
    // front controller mounts at `<docroot>/api/index.php`.
    "--volume", `${repoRoot}/php:/var/www/app:ro`,
    "--volume", `${repoRoot}/contracts/generated:/srv/eszter-contracts:ro`,
    "--volume", `${documentRoot}:/var/www/html`,
    "--env", "ESZTER_CONFIG=/srv/esz104/config.php",
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

  // The provisioning CLI runs as root (it enforces 0700 on its credentials
  // directory, which it can only chmod as the owner), then every file it may
  // have created in the shared runtime dirs is handed to www-data — the user
  // Apache's PHP runs as — so a root-owned lock or seed can never fail a
  // request with STORAGE_LOCK_FAILED.
  run("docker", ["exec", apacheName, "php", "/var/www/app/bin/migrate.php", `--config=/srv/esz104/config.php`]);
  run("docker", ["exec", apacheName, "php", "/var/www/app/bin/bootstrap-development.php",
    `--config=/srv/esz104/config.php`, `--credentials-file=/srv/esz104-creds/admin.json`]);
  run("docker", ["exec", apacheName, "sh", "-c",
    "chown -R www-data:www-data /srv/esz104/data /srv/esz104/var /srv/esz104/media-originals && chmod 0644 /srv/esz104-creds/admin.json && chmod 0755 /srv/esz104-creds"]);
  const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  assert(typeof credentials.email === "string" && typeof credentials.password === "string", "no dev credentials were written");

  // ── Local image fixtures: one HTTPS (self-signed), one plain HTTP ─────────
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1"]);
  const tlsPort = await freePort();
  const plainPort = await freePort();
  const plainUrl = `http://127.0.0.1:${plainPort}/proof.png`;
  const tlsUrl = `https://127.0.0.1:${tlsPort}/proof.png`;
  tlsServer = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, fixtureServer(proofImage, new Map()));
  plainServer = http.createServer(fixtureServer(proofImage, plainHits));
  await new Promise((resolveReady) => tlsServer.listen(tlsPort, "127.0.0.1", resolveReady));
  await new Promise((resolveReady) => plainServer.listen(plainPort, "127.0.0.1", resolveReady));

  // ── Browser session ───────────────────────────────────────────────────────
  const cdp = await launchChrome();
  const responses = [];
  const requestUrls = new Map();
  const loadingFailures = [];
  cdp.on("Network.responseReceived", ({ response }) => responses.push(response));
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => requestUrls.set(requestId, request.url));
  cdp.on("Network.loadingFailed", (failure) => loadingFailures.push({ ...failure, url: requestUrls.get(failure.requestId) ?? "" }));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: setCspViolationListenerSource() });
  // ESZ-113: real-browser performance evidence on the public page. The
  // observers record FCP/LCP/CLS into a fresh object per document; the values
  // are read back after the page has settled. These are lab measurements on
  // this disposable local stack — never field Core Web Vitals, no SLO.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__esz113Perf = { fcp: null, lcp: null, cls: 0, navType: performance.getEntriesByType?.("navigation")[0]?.type ?? null };
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === "first-contentful-paint") window.__esz113Perf.fcp = entry.startTime;
          }
        }).observe({ type: "paint" });
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length) window.__esz113Perf.lcp = Math.max(0, entries[entries.length - 1].startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) window.__esz113Perf.cls += entry.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch (error) {
        window.__esz113Perf.error = String(error);
      }
    })();`,
  });

  const measurePublicPerf = async (width, height, label, order) => {
    await setViewport(cdp, width, height);
    await navigateAndWait(cdp, `${origin}/`, `${label} performance load`, `Boolean(document.querySelector("h1"))`);
    // Let late fonts/media and post-load layout settle before reading LCP/CLS.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    const perf = await evaluate(cdp, `(() => {
      const value = window.__esz113Perf;
      return value && !value.error
        ? { fcp: Math.round(value.fcp ?? -1), lcp: Math.round(value.lcp ?? -1), cls: Math.round(value.cls * 1000) / 1000, navType: value.navType }
        : { error: value?.error ?? "no metrics object" };
    })()`);
    assert(perf.error === undefined, `${label}: performance observers failed: ${perf.error}`);
    assert(perf.fcp > 0 && perf.lcp > 0, `${label}: FCP/LCP missing: ${JSON.stringify(perf)}`);
    assert(typeof perf.cls === "number" && perf.cls >= 0, `${label}: CLS not measurable: ${JSON.stringify(perf)}`);
    perfResults.push(`${label} (${order} load, ${width}x${height}): FCP ${perf.fcp} ms, LCP ${perf.lcp} ms, CLS ${perf.cls}`);
    return perf;
  };

  // Public-page measurements at phone then desktop viewport, before any
  // authenticated or media work so the loads stay pristine.
  const perfResults = [];
  await measurePublicPerf(375, 667, "phone", "1st");
  await measurePublicPerf(1280, 800, "desktop", "2nd");

  await setViewport(cdp, 1280, 800);
  await signIn(cdp, origin, credentials.email, credentials.password);

  const publishedPolicy = await (async () => {
    const response = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
    return response.headers.get("content-security-policy");
  })();
  assert(publishedPolicy, "the Apache origin sends no Content-Security-Policy");
  const imgSources = policyDirective(publishedPolicy, "img-src");
  assert(
    JSON.stringify(imgSources) === JSON.stringify(["'self'", "https:"]),
    `img-src is not exactly 'self' https: — got ${JSON.stringify(imgSources)}`,
  );

  // The media fields render once the server draft has loaded; wait for the
  // Hero source field before asserting its copy.
  await waitFor(
    () => evaluate(cdp, `Boolean(document.getElementById("hero-visual-src"))`),
    "content editor media fields",
  );
  // Editor copy: the media field describes HTTPS-only external URLs.
  const editorCopy = await evaluate(cdp, `(() => {
    const input = document.getElementById("hero-visual-src");
    if (!input) return null;
    let ancestors = [];
    let node = input;
    for (let i = 0; i < 5 && node?.parentElement; i++) {
      node = node.parentElement;
      ancestors.push((node.className ?? "").toString().slice(0, 80));
    }
    return {
      placeholder: input.getAttribute("placeholder"),
      ancestors,
      bodyHasHelp: (document.body?.innerText ?? "").includes("Saisir une URL HTTPS, un chemin public commençant par /, ou choisir un média ci-dessous."),
      bodyHasOldHelp: (document.body?.innerText ?? "").includes("Saisir une URL http(s)"),
      bodyHead: (document.body?.innerText ?? "").slice(0, 400),
    };
  })()`);
  assert(editorCopy?.placeholder === "Ex. /media/med_… ou https://…", `unexpected media field placeholder ${esc(editorCopy?.placeholder)}`);
  assert(
    editorCopy.bodyHasHelp && !editorCopy.bodyHasOldHelp,
    `the media field help does not expose HTTPS as the external form; ancestors: ${esc(editorCopy?.ancestors)}; body head: ${esc(editorCopy?.bodyHead)}`,
  );

  // Editor preview: an HTTP source is never previewed, so it never becomes a request.
  await setReactInput(cdp, "hero-visual-src", plainUrl);
  await waitFor(
    () => evaluate(cdp, `document.body?.innerText?.includes("Aperçu indisponible : saisir une URL HTTPS valide ou un chemin public commençant par /.")`),
    "HTTP source refused by the editor preview",
  );
  const httpPreviewLeak = await evaluate(cdp, `(() => {
    const images = [...document.querySelectorAll("img")];
    const leaked = images.filter((image) => (image.getAttribute("src") ?? "").startsWith("http://"));
    return { leakedCount: leaked.length, previewTextShown: document.body?.innerText?.includes("Aperçu indisponible : saisir une URL HTTPS valide ou un chemin public commençant par /.") };
  })()`);
  assert(httpPreviewLeak.leakedCount === 0, "the editor rendered an <img> with an http:// source");
  assert(httpPreviewLeak.previewTextShown, "the editor does not show the preview-unavailable message for HTTP");
  assert((plainHits.get("/proof.png") ?? 0) === 0, "an http:// source typed in the editor reached the network");

  // Contract: an HTTP media source fails the draft-save envelope before publication.
  const auth = await adminSession(cdp, origin);
  const draft = await draftGet(origin, auth.cookie);
  const httpContent = structuredClone(draft.content);
  httpContent.hero.visual.src = plainUrl;
  const refused = await draftPut(origin, auth, draft.revision, httpContent);
  assert(refused.status === 400, `draft save with an http: media source returned ${refused.status}`);
  assert(refused.body?.error?.code === "VALIDATION_FAILED", `refusal code is not the existing VALIDATION_FAILED: ${JSON.stringify(refused.body)}`);
  assert(Object.keys(refused.body).join(",") === "error", "the refusal envelope carries more than the frozen error object");
  const afterRefusal = await draftGet(origin, auth.cookie);
  assert(afterRefusal.revision === draft.revision, "the refused http: media save still advanced the draft");
  assert((plainHits.get("/proof.png") ?? 0) === 0, "the refused save sent the http: image URL to the network");

  // Editor preview: an HTTPS external source previews and decodes (https: in the CSP).
  await setReactInput(cdp, "hero-visual-src", tlsUrl);
  const httpsPreview = await decodeEditorPreview(cdp, "hero-visual-src", "HTTPS editor preview image");
  assert(httpsPreview.src === tlsUrl, `editor preview decoded a different source: ${httpsPreview.src}`);

  // Managed media: upload a real image through the library, select it for the hero.
  const panelOpened = await evaluate(cdp, `(() => {
    const input = document.getElementById("hero-visual-src");
    const editor = input?.parentElement?.parentElement;
    const button = [...(editor?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent?.includes("Choisir dans la médiathèque"));
    button?.click();
    return Boolean(button);
  })()`);
  assert(panelOpened, "could not open the Hero media library");
  await waitFor(() => evaluate(cdp, `Boolean(document.getElementById("hero-visual-upload"))`), "Hero upload control");
  const documentNode = await cdp.send("DOM.getDocument");
  const uploadNode = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: "#hero-visual-upload",
  });
  assert(uploadNode.nodeId, "Chrome could not resolve the Hero upload input");
  await cdp.send("DOM.setFileInputFiles", { nodeId: uploadNode.nodeId, files: [proofImagePath] });

  const uploadedPath = await (async () => {
    try {
      return await waitFor(
        () => evaluate(cdp, `document.querySelector('#hero-visual-src')?.parentElement?.parentElement?.querySelector('button img[src^="/media/med_"]')?.getAttribute("src") ?? null`),
        "uploaded media library asset",
      );
    } catch (uploadError) {
      let panelStatus = "(unavailable)";
      try {
        panelStatus = await evaluate(cdp, `document.querySelector('[role="status"]')?.innerText ?? null`);
      } catch {
        // keep the placeholder
      }
      const mediaResponses = responses
        .filter((response) => response.url.includes("/api/admin/media"))
        .map((response) => ({ status: response.status, url: response.url }));
      let serverLog = "(unavailable)";
      try {
        serverLog = run("docker", ["exec", apacheName, "sh", "-c", "tail -n 4 /srv/esz104/var/log/app.log 2>/dev/null"]);
      } catch {
        // keep the placeholder
      }
      throw new Error(`${uploadError.message}; panel status: ${panelStatus}; media API: ${JSON.stringify(mediaResponses)}; server log: ${serverLog}`);
    }
  })();
  assert(/^\/media\/med_[0-9a-f]{32}\.(?:jpg|png|webp)$/.test(uploadedPath), `upload returned a non-managed path: ${uploadedPath}`);
  const selected = await evaluate(cdp, `(() => {
    const editor = document.querySelector('#hero-visual-src')?.parentElement?.parentElement;
    const image = [...(editor?.querySelectorAll("button img") ?? [])].find((candidate) => candidate.getAttribute("src") === ${esc(uploadedPath)});
    image?.closest("button")?.click();
    return Boolean(image);
  })()`);
  assert(selected, "the uploaded asset could not be selected from the Hero library");
  await waitFor(
    () => evaluate(cdp, `document.getElementById("hero-visual-src")?.value === ${esc(uploadedPath)}`),
    "Hero media selection",
  );
  const managedPreview = await decodeEditorPreview(cdp, "hero-visual-src", "same-origin managed editor preview");
  assert(managedPreview.src === uploadedPath, `the managed editor preview decoded a different source: ${managedPreview.src}`);

  // A gallery item carries the cross-origin HTTPS fixture.
  await setReactInput(cdp, "gallery-natural-brows-visual-src", tlsUrl);
  const galleryPreview = await decodeEditorPreview(cdp, "gallery-natural-brows-visual-src", "cross-origin HTTPS gallery editor preview");
  assert(galleryPreview.src === tlsUrl, `the gallery editor preview decoded a different source: ${galleryPreview.src}`);

  // Save and publish the draft through the real server workflow.
  await clickButton(cdp, "Enregistrer le brouillon");
  await waitFor(
    () => evaluate(cdp, `document.querySelector('[data-testid="admin-freshness"]')?.textContent?.trim() === "Brouillon enregistré, non publié"`),
    "server draft save",
  );
  await evaluate(cdp, `window.confirm = () => true`);
  await clickButton(cdp, "Publier");
  await waitFor(
    () => evaluate(cdp, `document.querySelector('[data-testid="admin-freshness"]')?.textContent?.trim() === "Publié"`),
    "publication",
  );

  // ── The public page under Apache: published content, links, deep links ────
  await cdp.send("Page.navigate", { url: `${origin}/` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && Boolean(document.querySelector("h1"))`),
    "public home page",
  );
  const envelope = await (await fetch(`${origin}/api/content`, { headers: { accept: "application/json" } })).json();
  const content = envelope.content;

  const heroImage = await decodeImage(cdp, 'img[data-editorial-media="hero"]', "published same-origin hero image");
  assert(heroImage.src === uploadedPath, `the public hero does not point at the published managed path: ${heroImage.src}`);
  const galleryImage = await decodeImage(cdp, 'img[data-editorial-media="gallery-natural-brows"]', "published cross-origin HTTPS gallery image");
  assert(galleryImage.src === tlsUrl, `the public gallery image does not point at the TLS fixture: ${galleryImage.src}`);

  const rendered = await evaluate(cdp, `(() => {
    const bySurface = (surface) => document.querySelector('img[data-editorial-media="' + surface + '"]')?.getAttribute("alt") ?? null;
    const navLinks = [...document.querySelectorAll("nav[aria-label='Navigation principale'] a")].map((a) => ({ text: a.textContent?.trim(), href: a.getAttribute("href") }));
    const galleryCta = document.querySelector("#realisations a[target='_blank']");
    const contactAnchors = [...document.querySelectorAll("#contact a")].map((a) => ({ text: a.textContent?.trim(), href: a.getAttribute("href") }));
    const footerLinks = [...document.querySelectorAll("footer a")].map((a) => ({ text: a.textContent?.trim(), href: a.getAttribute("href") }));
    const heroButton = document.querySelector('section[data-preview-section="site-section-hero"] button[aria-label]');
    const fallbacks = document.querySelectorAll("[data-editorial-media-fallback]").length;
    return {
      heroAlt: bySurface("hero"),
      galleryAlt: bySurface("gallery-natural-brows"),
      navLinks,
      galleryCta: galleryCta ? { text: galleryCta.textContent?.trim(), href: galleryCta.getAttribute("href"), target: galleryCta.getAttribute("target"), rel: galleryCta.getAttribute("rel") } : null,
      contactAnchors,
      footerLinks,
      heroButtonLabel: heroButton?.getAttribute("aria-label") ?? null,
      fallbacks,
      brand: document.querySelector("nav[aria-label='Navigation principale'] a[aria-label='Retour au début de la page']")?.textContent?.trim() ?? null,
    };
  })()`);
  assert(rendered.heroAlt === content.hero.visual.alt, "the public hero alt does not match the published envelope");
  assert(rendered.galleryAlt === content.gallery.items[0].visual.alt, "the public gallery alt does not match the published envelope");
  assert(rendered.fallbacks === 9, `expected 9 null-source fallbacks, got ${rendered.fallbacks}`);
  const declaredNav = new Map(content.navigation.links.map((link) => [link.label, link.href]));
  const contentNavLinks = rendered.navLinks.filter((link) => (link.href ?? "").startsWith("#") && link.href.length > 1);
  assert(
    contentNavLinks.length === content.navigation.links.length &&
      contentNavLinks.every((link) => declaredNav.get(link.text) === link.href),
    `rendered nav links diverge from the envelope: ${JSON.stringify(rendered.navLinks)}`,
  );
  assert(
    rendered.galleryCta?.href === content.gallery.instagramCta.href &&
      rendered.galleryCta.text === content.gallery.instagramCta.label &&
      rendered.galleryCta.target === "_blank" &&
      rendered.galleryCta.rel === "noopener noreferrer",
    "the gallery Instagram CTA does not resolve as declared",
  );
  assert(rendered.galleryCta.href.startsWith("https://www.instagram.com/"), "the gallery Instagram CTA is not HTTPS");
  assert(
    rendered.contactAnchors.some((link) => link.href === content.contact.instagramCta.href) &&
      rendered.contactAnchors.some((link) => link.href === content.contact.emailCta.href),
    "the contact CTAs do not resolve as declared",
  );
  assert(
    JSON.stringify(rendered.footerLinks.map((link) => link.href)) === JSON.stringify(content.footer.links.map((link) => link.href)),
    "the footer links diverge from the envelope",
  );
  assert(rendered.brand === content.navigation.brandLabel, "the brand label diverges from the envelope");
  assert(rendered.heroButtonLabel === content.hero.instagramAriaLabel, "the hero Instagram button loses its declared aria-label");
  const publicViolations = await evaluate(cdp, `window.__esz104Violations ?? []`);
  const publicImageViolations = imageViolations(publicViolations);
  assert(
    publicImageViolations.length === 0,
    `the published page produced img-src CSP violations: ${JSON.stringify(publicImageViolations)}`,
  );

  // In-page navigation: clicking a nav link lands below the fixed navbar.
  // The click starts from the top of the page — the canonical way a visitor
  // uses the fixed navigation — rather than from wherever an earlier image
  // decode left the scroll position.
  await evaluate(cdp, `window.scrollTo(0, 0)`);
  await clickAnchor(cdp, "Réalisations");
  await anchorLandsBelowNav(cdp, "realisations");
  await evaluate(cdp, `window.scrollTo(0, 0)`);
  await clickAnchor(cdp, "Me contacter");
  await anchorLandsBelowNav(cdp, "contact");

  // Direct deep links: each section id lands below the navbar on a fresh load.
  for (const target of ANCHOR_TARGETS) {
    await navigateAndWait(cdp, `${origin}/#${target}`, `deep link /#${target}`, `Boolean(document.getElementById(${esc(target)}))`);
    await anchorLandsBelowNav(cdp, target);
  }

  // ── Layout at phone, tablet and desktop widths ────────────────────────────
  const layoutResults = [];
  for (const [width, height, label] of [[375, 667, "phone"], [768, 1024, "tablet"], [1280, 800, "desktop"]]) {
    await setViewport(cdp, width, height);
    await navigateAndWait(cdp, `${origin}/`, `${label} home`, `Boolean(document.querySelector("h1"))`);
    const layout = await evaluate(cdp, `(() => {
      const html = document.documentElement;
      const nav = document.querySelector("nav[aria-label='Navigation principale']");
      const mobileButton = document.querySelector("nav button[aria-label]");
      const desktopLinks = [...document.querySelectorAll("nav[aria-label='Navigation principale'] a")].filter((a) => {
        const href = a.getAttribute("href") ?? "";
        return href.startsWith("#") && href.length > 1;
      });
      const visibleDesktop = desktopLinks.filter((a) => a.getBoundingClientRect().width > 0);
      return {
        scrollWidth: html.scrollWidth,
        clientWidth: html.clientWidth,
        heroTitle: document.querySelector("h1")?.textContent?.trim() ?? "",
        navVisible: nav ? nav.getBoundingClientRect().height > 0 : false,
        mobileButtonLabel: mobileButton?.getAttribute("aria-label") ?? null,
        desktopLinkCount: visibleDesktop.length,
      };
    })()`);
    assert(layout.navVisible, `${label}: the fixed navbar is not visible`);
    assert(layout.heroTitle.length > 20, `${label}: the hero title is not rendered`);
    assert(layout.scrollWidth <= layout.clientWidth + 1, `${label}: horizontal overflow ${layout.scrollWidth}px > ${layout.clientWidth}px`);
    if (label === "phone") {
      assert(layout.mobileButtonLabel === content.navigation.menuOpenLabel, `${label}: the mobile menu button is missing`);
    } else {
      assert(layout.desktopLinkCount === 5, `${label}: expected the five navigation links inline, saw ${layout.desktopLinkCount}`);
    }
    const violations = await evaluate(cdp, `window.__esz104Violations ?? []`);
    assert(
      imageViolations(violations).length === 0,
      `${label}: layout pass produced img-src CSP violations: ${JSON.stringify(imageViolations(violations))}`,
    );
    layoutResults.push(`${label}: ${layout.clientWidth}px wide, no overflow`);
  }

  // ── ESZ-113 keyboard proofs on the public page ───────────────────────────
  const keyEvent = async (type, key, code, keyCode) => {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  };
  const pressKeySimple = async (key, code, keyCode) => {
    await keyEvent("rawKeyDown", key, code, keyCode);
    await keyEvent("keyUp", key, code, keyCode);
  };

  // Skip link: first focusable element, becomes visible on focus, and Enter
  // moves focus to the main landmark it promises.
  await setViewport(cdp, 1280, 800);
  await navigateAndWait(cdp, `${origin}/`, "a11y: public home for the skip link", `Boolean(document.querySelector("h1"))`);
  await evaluate(cdp, `window.scrollTo(0, 0)`);
  await pressKeySimple("Tab", "Tab", 9);
  await waitFor(
    () => evaluate(cdp, `document.activeElement?.textContent?.trim() === "Aller au contenu principal"`),
    "skip link focused",
    10_000,
  );
  // The skip link slides into view (top: -6rem -> 0.75rem, 160 ms transition);
  // wait for the transition to settle, then measure visibility.
  const skipFocus = await waitFor(
    () => evaluate(cdp, `(() => {
      const element = document.activeElement;
      const rect = element?.getBoundingClientRect();
      const visible = Boolean(rect && rect.width > 0 && rect.height > 0
        && rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0);
      if (!visible) return null;
      return {
        tag: element?.tagName.toLowerCase() ?? null,
        text: (element?.textContent ?? "").trim(),
        href: element?.getAttribute("href") ?? null,
        visible,
        top: Math.round(rect?.top ?? NaN),
      };
    })()`),
    "skip link focused and settled into view",
    3_000,
  );
  assert(
    skipFocus.tag === "a" && skipFocus.text === "Aller au contenu principal" && skipFocus.href === "#main-content",
    `Tab did not reach the skip link first: ${JSON.stringify(skipFocus)}`,
  );
  assert(skipFocus.visible, `the focused skip link is not visible on screen: ${JSON.stringify(skipFocus)}`);
  await pressKeySimple("Enter", "Enter", 13);
  await waitFor(
    () => evaluate(cdp, `document.activeElement?.id === "main-content"`),
    "skip-link focus landing on #main-content",
  );

  // Mobile menu: open focuses the first link, Escape closes and restores
  // focus to the trigger, the backdrop click closes the same way, the closed
  // menu is absent from the DOM, and aria-expanded/aria-controls agree with
  // the real state at every step.
  await setViewport(cdp, 375, 667);
  await navigateAndWait(cdp, `${origin}/`, "a11y: public home for the mobile menu", `Boolean(document.querySelector("h1"))`);
  const menuOpenLabel = content.navigation.menuOpenLabel;
  const menuCloseLabel = content.navigation.menuCloseLabel;
  const firstLinkLabel = content.navigation.links[0].label;
  const closedMenu = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === ${esc(menuOpenLabel)});
    return button
      ? {
          expanded: button.getAttribute("aria-expanded"),
          controls: button.getAttribute("aria-controls"),
          menuPresent: Boolean(document.getElementById("mobile-navigation-menu")),
        }
      : null;
  })()`);
  assert(closedMenu && closedMenu.expanded === "false", `the closed menu trigger does not declare aria-expanded=false: ${JSON.stringify(closedMenu)}`);
  assert(closedMenu?.controls === "mobile-navigation-menu", "the menu trigger does not declare its controls");
  assert(closedMenu?.menuPresent === false, "the closed mobile menu is still in the DOM");
  // Open with retries: the exported HTML already contains the trigger button,
  // so a click can land before React has hydrated and attached its handler.
  // Each retry re-checks the real state instead of blindly toggling.
  const openMobileMenu = async () => {
    let state = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      state = await evaluate(cdp, `(() => {
        const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-controls") === "mobile-navigation-menu");
        return {
          expanded: button?.getAttribute("aria-expanded") ?? null,
          menuPresent: Boolean(document.getElementById("mobile-navigation-menu")),
          activeText: document.activeElement?.textContent?.trim() ?? null,
        };
      })()`);
      if (state.menuPresent && state.activeText === firstLinkLabel) return state;
      if (state.expanded === "false") {
        await evaluate(cdp, `(() => {
          const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-controls") === "mobile-navigation-menu");
          button?.click();
          return Boolean(button);
        })()`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    }
    return state;
  };
  const openState = await openMobileMenu();
  assert(openState?.menuPresent, `the mobile menu did not open: ${JSON.stringify(openState)}`);
  assert(openState.activeText === firstLinkLabel, `the open menu did not focus its first link: ${JSON.stringify(openState)}`);
  const openMenu = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === ${esc(menuCloseLabel)});
    return {
      expanded: button?.getAttribute("aria-expanded") ?? null,
      mobileNavPresent: Boolean(document.querySelector('nav[aria-label="Navigation mobile"]')),
      scrollLocked: document.body.style.overflow === "hidden",
    };
  })()`);
  assert(openMenu.expanded === "true", "the open menu trigger does not declare aria-expanded=true");
  assert(openMenu.mobileNavPresent, "the open menu is not exposed as the labelled mobile navigation");
  assert(openMenu.scrollLocked, "the body scroll lock is not held while the menu is open");
  await pressKeySimple("Escape", "Escape", 27);
  await waitFor(
    () => evaluate(cdp, `!document.getElementById("mobile-navigation-menu")`),
    "Escape closing the mobile menu",
  );
  const closedByEscape = await evaluate(cdp, `(() => {
    const element = document.activeElement;
    return {
      expanded: [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-controls") === "mobile-navigation-menu")?.getAttribute("aria-expanded") ?? null,
      focusLabel: element?.getAttribute("aria-label") ?? null,
      scrollRestored: document.body.style.overflow !== "hidden",
    };
  })()`);
  assert(closedByEscape.expanded === "false", "Escape did not close the menu state");
  assert(closedByEscape.focusLabel === menuOpenLabel, `Escape did not restore focus to the trigger: ${closedByEscape.focusLabel}`);
  assert(closedByEscape.scrollRestored, "Escape left the body scroll locked");

  // Backdrop click: same close contract as Escape.
  const reopenedState = await openMobileMenu();
  assert(reopenedState?.menuPresent, `could not reopen the mobile menu: ${JSON.stringify(reopenedState)}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 187, y: 620, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 187, y: 620, button: "left", clickCount: 1 });
  await waitFor(
    () => evaluate(cdp, `!document.getElementById("mobile-navigation-menu")`),
    "backdrop click closing the mobile menu",
  );
  const closedByBackdrop = await evaluate(cdp, `(() => ({
    expanded: [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-controls") === "mobile-navigation-menu")?.getAttribute("aria-expanded") ?? null,
    focusLabel: document.activeElement?.getAttribute("aria-label") ?? null,
  }))()`);
  assert(closedByBackdrop.expanded === "false", "the backdrop click did not close the menu state");
  assert(closedByBackdrop.focusLabel === menuOpenLabel, `the backdrop click did not restore focus to the trigger: ${closedByBackdrop.focusLabel}`);

  // 320 px: no document overflow and the mobile trigger stays usable.
  await setViewport(cdp, 320, 700);
  await navigateAndWait(cdp, `${origin}/`, "public home at 320 px", `Boolean(document.querySelector("h1"))`);
  const public320 = await evaluate(cdp, `(() => {
    const html = document.documentElement;
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-controls") === "mobile-navigation-menu");
    const rect = button?.getBoundingClientRect();
    return {
      scrollWidth: html.scrollWidth,
      clientWidth: html.clientWidth,
      triggerUsable: Boolean(rect && rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= html.clientWidth + 1),
    };
  })()`);
  assert(public320.scrollWidth <= public320.clientWidth + 1, `public page overflows at 320 px: ${public320.scrollWidth} > ${public320.clientWidth}`);
  assert(public320.triggerUsable, "the mobile menu trigger is not usable at 320 px");
  await setViewport(cdp, 1280, 800);

  // ── The ESZ-104 CSP probe page: same-origin, cross-origin HTTPS, and an
  //    injected HTTP negative control, all under the committed .htaccess ─────
  writeFileSync(
    join(documentRoot, probePath.slice(1)),
    `<!doctype html><html><head><meta charset="utf-8"><title>${PROBE_TITLE}</title></head>
<body>
  <img id="same-origin" src="${origin}${uploadedPath}" alt="same-origin managed image">
  <img id="cross-origin-https" src="${tlsUrl}" alt="cross-origin HTTPS fixture image">
  <script>
    window.__esz104Probe = {
      injectedUrl: ${esc(plainUrl)},
      violations: [],
      injectedLoaded: false,
      injectedFailed: false,
      injected: null,
    };
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__esz104Probe.violations.push({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
      });
    });
    const injected = document.createElement("img");
    injected.id = "injected-http";
    injected.alt = "intentionally invalid HTTP image";
    injected.addEventListener("load", () => { window.__esz104Probe.injectedLoaded = true; });
    injected.addEventListener("error", () => { window.__esz104Probe.injectedFailed = true; });
    document.body.appendChild(injected);
    window.__esz104Probe.injected = injected;
    injected.src = ${esc(plainUrl)};
  </script>
</body></html>`,
  );

  await navigateAndWait(cdp, `${origin}${probePath}`, "ESZ-104 CSP probe", `document.title === ${esc(PROBE_TITLE)}`);
  const sameOriginProbe = await decodeImage(cdp, "#same-origin", "probe same-origin image");
  assert(sameOriginProbe.src === `${origin}${uploadedPath}`, "the probe same-origin image did not decode");
  const crossOriginProbe = await decodeImage(cdp, "#cross-origin-https", "probe cross-origin HTTPS image");
  assert(crossOriginProbe.src === tlsUrl, "the probe cross-origin HTTPS image did not decode");
  await waitFor(
    () => evaluate(cdp, `window.__esz104Probe?.injectedFailed === true`),
    "injected HTTP image error event",
    15_000,
  );

  const probe = await evaluate(cdp, `(() => {
    const probe = window.__esz104Probe;
    const violations = window.__esz104Violations ?? [];
    return {
      probeViolations: probe?.violations ?? [],
      pageViolations: violations,
      injectedLoaded: probe?.injectedLoaded ?? null,
      injectedFailed: probe?.injectedFailed ?? null,
      injectedDecoded: document.getElementById("injected-http")?.naturalWidth > 0,
      sameDecoded: document.getElementById("same-origin")?.naturalWidth > 0,
      crossDecoded: document.getElementById("cross-origin-https")?.naturalWidth > 0,
    };
  })()`);
  const cspBlocked = [...probe.probeViolations, ...probe.pageViolations].filter(
    (violation) => violation.blockedURI === plainUrl && violation.effectiveDirective === "img-src",
  );
  assert(probe.sameDecoded, "the same-origin probe image did not decode");
  assert(probe.crossDecoded, "the cross-origin HTTPS probe image did not decode");
  assert(!probe.injectedLoaded && probe.injectedFailed, "the injected HTTP image was not blocked");
  assert(!probe.injectedDecoded, "the injected HTTP image decoded despite the policy");
  assert(cspBlocked.length >= 1, `no img-src CSP violation recorded for ${plainUrl}: ${JSON.stringify(probe)}`);
  const cspLoadingFailure = loadingFailures.find(
    (failure) => failure.url === plainUrl && failure.blockedReason === "csp",
  );
  assert(cspLoadingFailure, `Chrome did not report the HTTP image as blocked by CSP: ${JSON.stringify(loadingFailures)}`);
  const probePolicy = (responses.find((response) => response.url === `${origin}${probePath}`) ?? { headers: {} });
  const probeCsp = responseHeader(probePolicy.headers ?? {}, "content-security-policy");
  assert(probeCsp, "the probe response carried no CSP");
  assert(
    JSON.stringify(policyDirective(probeCsp, "img-src")) === JSON.stringify(["'self'", "https:"]),
    `the served CSP img-src is not 'self' https: — ${probeCsp}`,
  );

  // The HTTP fixture origin demonstrably serves images — the block above is
  // the CSP, not a dead server. (The injected <img> never reached it.)
  const directHttp = await fetch(plainUrl);
  assert(directHttp.status === 200, `the plain HTTP fixture returned ${directHttp.status}`);
  const plainHitCount = plainHits.get("/proof.png") ?? 0;
  assert(plainHitCount === 1, `the plain HTTP fixture saw ${plainHitCount} requests, expected exactly the one direct probe`);
  const mediaResponse = responses.find((response) => response.url === `${origin}${uploadedPath}`);
  assert(mediaResponse?.status === 200, `the managed image was not served: ${JSON.stringify(mediaResponse)}`);

  cdp.close();
  process.stdout.write("browser:public proof: PASS\n");
  process.stdout.write(`CSP served by Apache: ${publishedPolicy}\n`);
  process.stdout.write(`same-origin: ${uploadedPath} loaded and decoded under 'self' (published page and probe)\n`);
  process.stdout.write(`cross-origin HTTPS: ${tlsUrl} loaded and decoded under scheme-wide https:\n`);
  process.stdout.write("http media: editor never previewed it; draft-save refused 400 VALIDATION_FAILED, draft unchanged\n");
  process.stdout.write(`negative control: injected ${plainUrl} blocked by img-src (violation + loadingFailed reason=csp); the fixture answered only the direct reachability probe\n`);
  process.stdout.write(`navigation: in-page clicks and ${ANCHOR_TARGETS.length} direct deep links land below the fixed navbar\n`);
  process.stdout.write(`layout: ${layoutResults.join("; ")}\n`);
  process.stdout.write(`performance (lab measurements on the disposable local origin, no SLO): ${perfResults.join("; ")}\n`);
  process.stdout.write("accessibility: skip link first in the keyboard order and visible on focus, Enter lands on #main-content; mobile menu open focuses its first link, Escape and the backdrop close it with aria-expanded and focus restored to the trigger; 320 px reflow holds without overflow\n");
  process.stdout.write(`envelope fidelity: hero + gallery alts, ${content.navigation.links.length} nav links, gallery/contact/footer links match /api/content\n`);
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  try {
    stopProcessQuietly(chrome);
    await stopServer(tlsServer);
    await stopServer(plainServer);
    if (apacheContainer) {
      runIgnoringExit("docker", ["exec", apacheName, "sh", "-c", "rm -rf /srv/esz104 /srv/esz104-creds /var/www/html"]);
    }
    if (apacheContainer) runIgnoringExit("docker", ["rm", "--force", apacheName]);
    if (mysqlContainer) runIgnoringExit("docker", ["rm", "--force", mysqlName]);
    runIgnoringExit("docker", ["network", "rm", networkName]);
    rmSync(workRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    process.stderr.write(`browser:public cleanup failed: ${cleanupError.message}\n`);
  }
}

if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  process.exit(1);
}
