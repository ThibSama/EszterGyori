#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apacheImage = process.env.ESZTER_CSP_APACHE_IMAGE ?? "php:8.4-apache";
const chromeBinary = process.env.ESZTER_CSP_CHROME ?? "google-chrome";
const workRoot = mkdtempSync(join(tmpdir(), "eszter-admin-preview-csp-"));
const documentRoot = join(workRoot, "public_html");
const chromeProfile = join(workRoot, "chrome-profile");
const probePath = "/__esz095_admin_preview_csp.html";
const externalFrame = "https://example.com/__esz095_must_be_blocked";
const externalOrigin = new URL(externalFrame).origin;
let apacheContainer = null;
let chrome = null;

function fail(message) {
  throw new Error(`admin preview CSP proof: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function header(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

function directives(policy) {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

function assertRestrictivePolicy(policy) {
  const parsed = directives(policy);
  assert(JSON.stringify(parsed.get("frame-src")) === JSON.stringify(["'self'"]), "frame-src must be exactly 'self'");
  assert(JSON.stringify(parsed.get("frame-ancestors")) === JSON.stringify(["'self'"]), "frame-ancestors must be exactly 'self'");
  assert(JSON.stringify(parsed.get("object-src")) === JSON.stringify(["'none'"]), "object-src 'none' is missing");
  assert(JSON.stringify(parsed.get("default-src")) === JSON.stringify(["'self'"]), "default-src must remain 'self'");
  for (const directive of ["base-uri", "form-action", "connect-src", "font-src"]) {
    assert(JSON.stringify(parsed.get(directive)) === JSON.stringify(["'self'"]), `${directive} must remain 'self'`);
  }
  assert(!policy.includes("*"), "the CSP contains a wildcard source");
  assert(!/https?:\/\//.test(policy), "the CSP contains a named external HTTP origin");
  assert(!/(?:^|\s)(?:https?|data|blob):(?:\s|$)/.test(parsed.get("frame-src")?.join(" ") ?? ""), "frame-src contains a scheme-wide source");
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  fail(`${description} did not become ready${lastError ? `: ${lastError.message}` : ""}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener("open", resolveReady, { once: true });
      this.socket.addEventListener("error", () => rejectReady(new Error("Chrome DevTools connection failed")), { once: true });
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
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
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

async function stopProcess(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => process.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
  ]);
  if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
}

async function main() {
  const exportRoot = join(repoRoot, "front", "out");
  const htaccessPath = join(repoRoot, "php", "public", ".htaccess");
  assert(existsSync(join(exportRoot, "admin", "preview.html")), "front/out/admin/preview.html is missing; run npm run build first");
  assert(existsSync(htaccessPath), "php/public/.htaccess is missing");

  cpSync(exportRoot, documentRoot, { recursive: true });
  cpSync(htaccessPath, join(documentRoot, ".htaccess"));
  writeFileSync(
    join(documentRoot, probePath.slice(1)),
    `<!doctype html><html><head><meta charset="utf-8"><title>ESZ-095 CSP probe</title><script>
window.__esz095Violations = [];
document.addEventListener("securitypolicyviolation", (event) => {
  window.__esz095Violations.push({blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective});
});
</script></head><body>
<iframe id="admin-preview" title="Admin preview CSP proof" src="/admin/preview"></iframe>
<iframe id="external-frame" title="External frame negative control" src="${externalFrame}"></iframe>
</body></html>`,
  );

  apacheContainer = run("docker", [
    "run", "--detach", "--rm", "--publish", "127.0.0.1::80",
    "--volume", `${documentRoot}:/var/www/html:ro`, apacheImage,
    "sh", "-c",
    "a2enmod headers rewrite >/dev/null && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf && exec apache2-foreground",
  ]);
  const portOutput = await waitFor(
    () => run("docker", ["port", apacheContainer, "80/tcp"]),
    "Apache port publication",
  );
  const port = /:(\d+)$/.exec(portOutput)?.[1];
  assert(port, `could not parse Apache port from ${portOutput}`);
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    const response = await fetch(`${origin}${probePath}`);
    return response.status === 200;
  }, "Apache");

  chrome = spawn(chromeBinary, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${chromeProfile}`, "about:blank",
  ], { stdio: "ignore" });
  const devtoolsFile = join(chromeProfile, "DevToolsActivePort");
  const devtools = await waitFor(
    () => existsSync(devtoolsFile) && readFileSync(devtoolsFile, "utf8").trim(),
    "headless Chrome DevTools endpoint",
  );
  const debugPort = devtools.split(/\r?\n/, 1)[0];
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === "page");
  assert(target?.webSocketDebuggerUrl, "Chrome exposed no debuggable page");

  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  const responses = [];
  const requestUrls = new Map();
  const failedRequests = [];
  cdp.on("Network.responseReceived", ({ response }) => responses.push(response));
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => requestUrls.set(requestId, request.url));
  cdp.on("Network.loadingFailed", (failure) => failedRequests.push({
    ...failure,
    url: requestUrls.get(failure.requestId) ?? "",
  }));
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: `${origin}${probePath}` });

  const browserState = await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const preview = document.getElementById("admin-preview");
        if (!preview?.contentDocument || preview.contentDocument.readyState !== "complete") return null;
        if (preview.contentWindow.location.pathname !== "/admin/preview") return null;
        return {
          previewPath: preview.contentWindow.location.pathname,
          previewTitle: preview.contentDocument.title,
          previewText: preview.contentDocument.body?.innerText ?? "",
          violations: window.__esz095Violations ?? [],
        };
      })()`,
      returnByValue: true,
    });
    return evaluated.result.value;
  }, "same-origin admin preview iframe");

  const relevantResponses = responses.filter(({ url }) => url === `${origin}${probePath}` || url === `${origin}/admin/preview`);
  const observedPolicies = relevantResponses.map((response) => header(response.headers, "content-security-policy"));
  assert(
    relevantResponses.some(({ url, status }) => url === `${origin}/admin/preview` && status === 200),
    `/admin/preview did not return HTTP 200 in the iframe; observed ${responses.map(({ url, status }) => `${status} ${url}`).join(", ")}`,
  );
  assert(observedPolicies.length === 2 && observedPolicies.every(Boolean), "the probe and preview responses did not both carry Content-Security-Policy");
  assert(new Set(observedPolicies).size === 1, "the probe and preview responses carried different CSP values");
  const policy = observedPolicies[0];
  assertRestrictivePolicy(policy);

  assert(browserState.previewPath === "/admin/preview", `same-origin iframe ended at ${browserState.previewPath}`);
  assert(browserState.previewTitle.includes("Aperçu"), "the real admin preview document did not load");
  assert(browserState.previewText.trim().length > 100, "the real admin preview rendered no meaningful content");
  assert(
    !browserState.violations.some((violation) => violation.blockedURI === `${origin}/admin/preview`),
    "the same-origin admin preview caused a CSP violation",
  );
  assert(
    browserState.violations.some(
      (violation) => violation.blockedURI === externalOrigin && violation.effectiveDirective === "frame-src",
    ),
    `the external iframe did not produce the expected frame-src violation; observed ${JSON.stringify(browserState.violations)}`,
  );
  assert(
    !failedRequests.some((failure) => failure.blockedReason === "csp" && failure.url === `${origin}/admin/preview`),
    "Chrome reported the same-origin preview as blocked by CSP",
  );

  cdp.close();
  process.stdout.write(`admin preview CSP proof: PASS\nCSP: ${policy}\n`);
  process.stdout.write("same-origin: /admin/preview loaded and rendered in the iframe with no CSP violation\n");
  process.stdout.write(`cross-origin: ${externalFrame} blocked by frame-src\n`);
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  await stopProcess(chrome);
  if (apacheContainer) spawnSync("docker", ["rm", "--force", apacheContainer], { stdio: "ignore" });
  rmSync(workRoot, { recursive: true, force: true });
}

if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  process.exit(1);
}
