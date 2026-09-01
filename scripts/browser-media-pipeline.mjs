#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
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
const chromeBinary = process.env.ESZTER_MEDIA_CHROME ?? "google-chrome";
const workRoot = mkdtempSync(join(tmpdir(), "eszter-media-pipeline-"));
const chromeProfile = join(workRoot, "chrome-profile");
const configPath = join(workRoot, "config.php");
const credentialsPath = join(workRoot, "admin.json");
const uploadPath = join(workRoot, "proof.png");
const databaseName = "eszter_media_proof";
const databaseUsername = "eszter_media_proof";
const databasePassword = "eszter_media_proof_only";
const databaseRootPassword = "eszter_media_root_proof_only";
const exportedMediaRoot = join(repoRoot, "front", "out", "media");
const exportedMediaExisted = existsSync(exportedMediaRoot);
let mysqlContainer = null;
let phpServer = null;
let phpServerExit = null;
let chrome = null;
let uploadedPath = null;

function fail(message) {
  throw new Error(`media pipeline browser proof: ${message}`);
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
  if (result.status !== 0) {
    fail(`${command} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
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

async function stopProcess(process, exitPromise) {
  if (!process || !exitPromise || process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  const stopped = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 3000)),
  ]);
  if (!stopped) process.kill("SIGKILL");
}

function phpString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

async function main() {
  assert(existsSync(join(repoRoot, "front", "out", "index.html")), "front/out is missing; run npm run build first");
  assert(existsSync(join(repoRoot, "php", "vendor", "autoload.php")), "php/vendor is missing; install Composer dependencies first");

  mysqlContainer = run(
    "docker",
    [
      "run", "--detach", "--rm", "--publish", "127.0.0.1::3306",
      "--env", "MYSQL_DATABASE", "--env", "MYSQL_USER",
      "--env", "MYSQL_PASSWORD", "--env", "MYSQL_ROOT_PASSWORD",
      "mysql:8.4",
    ],
    {
      env: {
        ...process.env,
        MYSQL_DATABASE: databaseName,
        MYSQL_USER: databaseUsername,
        MYSQL_PASSWORD: databasePassword,
        MYSQL_ROOT_PASSWORD: databaseRootPassword,
      },
    },
  );

  await waitFor(() => {
    const result = spawnSync(
      "docker",
      [
        "exec", mysqlContainer, "sh", "-lc",
        'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent',
      ],
      { stdio: "ignore" },
    );
    return result.status === 0;
  }, "isolated MySQL", 60_000);

  const portOutput = run("docker", ["port", mysqlContainer, "3306/tcp"]);
  const databasePort = /:(\d+)$/.exec(portOutput)?.[1];
  assert(databasePort, `could not parse the isolated MySQL port from ${portOutput}`);

  writeFileSync(
    configPath,
    `<?php\ndeclare(strict_types=1);\nreturn [
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
  'session' => [
    'cookieSecure' => false,
    'idleTimeoutSeconds' => 3600,
    'absoluteTimeoutSeconds' => 43200,
  ],
];\n`,
    { mode: 0o600 },
  );

  run("php", ["php/bin/migrate.php", `--config=${configPath}`]);
  run("php", [
    "php/bin/bootstrap-development.php",
    `--config=${configPath}`,
    `--credentials-file=${credentialsPath}`,
  ]);
  const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));

  run("php", [
    "-r",
    '$image=imagecreatetruecolor(96,64);$background=imagecolorallocate($image,99,114,108);$accent=imagecolorallocate($image,238,226,215);imagefilledrectangle($image,0,0,95,63,$background);imagefilledellipse($image,48,32,54,38,$accent);imagepng($image,$argv[1]);',
    uploadPath,
  ]);

  const httpPort = await freePort();
  const origin = `http://127.0.0.1:${httpPort}`;
  phpServer = spawn(
    "php",
    [
      "-S", `127.0.0.1:${httpPort}`,
      "-t", join(repoRoot, "front", "out"),
      join(repoRoot, "php", "public", "router.php"),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ESZTER_CONFIG: configPath },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  phpServerExit = new Promise((resolveExit) => phpServer.once("exit", resolveExit));
  await waitFor(async () => {
    const response = await fetch(`${origin}/api/health`);
    return response.status === 200;
  }, "isolated PHP application", 45_000);

  chrome = spawn(
    chromeBinary,
    [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
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

  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  const mediaResponses = [];
  cdp.on("Network.responseReceived", ({ response }) => {
    if (response.url.includes("/media/")) {
      mediaResponses.push({ url: response.url, status: response.status, mimeType: response.mimeType });
    }
  });
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Page.navigate", { url: `${origin}/admin/login` });

  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && Boolean(document.getElementById("admin-login-email"))`),
    "admin login page",
  );
  await setReactInput(cdp, "admin-login-email", credentials.email);
  await setReactInput(cdp, "admin-login-password", credentials.password);
  assert(await evaluate(cdp, `(() => { const button = document.querySelector('button[type="submit"]'); button?.click(); return Boolean(button); })()`), "could not submit login");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin" && Boolean(document.getElementById("hero-visual-src"))`),
    "authenticated content editor",
    45_000,
  );

  const initialFallbacks = await waitFor(
    () => evaluate(cdp, `document.querySelector('iframe[title="Aperçu en direct du site"]')?.contentDocument?.querySelectorAll("[data-editorial-media-fallback]").length === 11 ? 11 : 0`),
    "all-null preview fallbacks",
  );

  const brokenPath = "/media/med_00000000000000000000000000000000.webp";
  await setReactInput(cdp, "hero-visual-src", brokenPath);
  await waitFor(
    () => evaluate(cdp, `Boolean(document.querySelector('iframe[title="Aperçu en direct du site"]')?.contentDocument?.querySelector('[data-editorial-media-fallback="hero"]'))`),
    "broken Hero fallback",
  );

  const panelOpened = await evaluate(cdp, `(() => {
    const input = document.getElementById("hero-visual-src");
    const editor = input?.parentElement?.parentElement;
    const button = [...(editor?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent?.includes("Choisir dans la médiathèque"));
    button?.click();
    return Boolean(button);
  })()`);
  assert(panelOpened, "could not open the Hero media library");
  await waitFor(
    () => evaluate(cdp, `Boolean(document.getElementById("hero-visual-upload"))`),
    "Hero upload control",
  );
  const documentNode = await cdp.send("DOM.getDocument");
  const uploadNode = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: "#hero-visual-upload",
  });
  assert(uploadNode.nodeId, "Chrome could not resolve the Hero upload input");
  await cdp.send("DOM.setFileInputFiles", {
    nodeId: uploadNode.nodeId,
    files: [uploadPath],
  });

  uploadedPath = await waitFor(
    () => evaluate(cdp, `document.querySelector('#hero-visual-src')?.parentElement?.parentElement?.querySelector('button img[src^="/media/med_"]')?.getAttribute("src") ?? null`),
    "uploaded media library asset",
    45_000,
  );
  assert(/^\/media\/med_[0-9a-f]{32}\.(?:jpg|png|webp)$/.test(uploadedPath), "upload returned a non-managed path");

  const selected = await evaluate(cdp, `(() => {
    const editor = document.querySelector('#hero-visual-src')?.parentElement?.parentElement;
    const image = [...(editor?.querySelectorAll('button img') ?? [])].find((candidate) => candidate.getAttribute("src") === ${JSON.stringify(uploadedPath)});
    image?.closest("button")?.click();
    return Boolean(image);
  })()`);
  assert(selected, "the uploaded asset could not be selected from the Hero library");
  await waitFor(
    () => evaluate(cdp, `document.getElementById("hero-visual-src")?.value === ${JSON.stringify(uploadedPath)}`),
    "Hero media selection",
  );

  const remainingFields = [
    "service-brows-visual-src",
    "service-eyeliner-visual-src",
    "service-lips-visual-src",
    "service-freckles-visual-src",
    "gallery-natural-brows-visual-src",
    "gallery-healed-brows-visual-src",
    "gallery-delicate-eyeliner-visual-src",
    "gallery-powder-lips-visual-src",
    "gallery-freckles-visual-src",
    "about-portrait-src",
  ];
  for (const field of remainingFields) await setReactInput(cdp, field, uploadedPath);

  const previewResult = await waitFor(
    () => evaluate(cdp, `(async () => {
      const frame = document.querySelector('iframe[title="Aperçu en direct du site"]');
      const frameDocument = frame?.contentDocument;
      const frameWindow = frame?.contentWindow;
      if (!frameDocument || !frameWindow) return null;
      const images = [...frameDocument.querySelectorAll("img[data-editorial-media]")];
      if (images.length !== 11) return null;
      for (const image of images) {
        image.scrollIntoView({ block: "center" });
        if (!image.complete) {
          await new Promise((resolveImage) => {
            image.addEventListener("load", resolveImage, { once: true });
            image.addEventListener("error", resolveImage, { once: true });
            frameWindow.setTimeout(resolveImage, 5000);
          });
        }
        if (image.naturalWidth < 1 || image.naturalHeight < 1) return null;
      }
      const mappings = [
        ["hero", "hero-visual-alt"],
        ["service-brows", "service-brows-visual-alt"],
        ["service-eyeliner", "service-eyeliner-visual-alt"],
        ["service-lips", "service-lips-visual-alt"],
        ["service-freckles", "service-freckles-visual-alt"],
        ["gallery-natural-brows", "gallery-natural-brows-visual-alt"],
        ["gallery-healed-brows", "gallery-healed-brows-visual-alt"],
        ["gallery-delicate-eyeliner", "gallery-delicate-eyeliner-visual-alt"],
        ["gallery-powder-lips", "gallery-powder-lips-visual-alt"],
        ["gallery-freckles", "gallery-freckles-visual-alt"],
        ["about", "about-portrait-alt"],
      ];
      const altMatches = mappings.every(([surface, inputId]) =>
        frameDocument.querySelector('[data-editorial-media="' + surface + '"]')?.getAttribute("alt") === document.getElementById(inputId)?.value
      );
      return { count: images.length, altMatches, loaded: images.every((image) => image.complete && image.naturalWidth > 0) };
    })()`, true),
    "all preview media images",
    45_000,
  );
  assert(previewResult.altMatches, "preview image alt text does not match the editorial fields");
  assert(previewResult.loaded, "one or more preview images did not decode successfully");

  assert(await evaluate(cdp, `(() => { const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Enregistrer le brouillon"); button?.click(); return Boolean(button); })()`), "could not save the draft");
  await waitFor(
    () => evaluate(cdp, `document.querySelector('[data-testid="admin-freshness"]')?.textContent?.trim() === "Brouillon enregistré, non publié"`),
    "server draft save",
    45_000,
  );
  await evaluate(cdp, `window.confirm = () => true`);
  assert(await evaluate(cdp, `(() => { const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Publier"); button?.click(); return Boolean(button); })()`), "could not publish the draft");
  await waitFor(
    () => evaluate(cdp, `document.querySelector('[data-testid="admin-freshness"]')?.textContent?.trim() === "Publié"`),
    "publication",
    45_000,
  );

  await cdp.send("Page.navigate", { url: `${origin}/` });
  const publicResult = await waitFor(
    () => evaluate(cdp, `(async () => {
      if (document.readyState !== "complete") return null;
      const images = [...document.querySelectorAll("img[data-editorial-media]")];
      if (images.length !== 11) return null;
      for (const image of images) {
        image.scrollIntoView({ block: "center" });
        if (!image.complete) {
          await new Promise((resolveImage) => {
            image.addEventListener("load", resolveImage, { once: true });
            image.addEventListener("error", resolveImage, { once: true });
            window.setTimeout(resolveImage, 5000);
          });
        }
        if (image.naturalWidth < 1 || image.naturalHeight < 1) return null;
      }
      const envelope = await fetch("/api/content", { headers: { accept: "application/json" } }).then((response) => response.json());
      const expected = new Map([
        ["hero", envelope.content.hero.visual.alt],
        ...envelope.content.services.items.map((item) => ["service-" + item.id, item.visual.alt]),
        ...envelope.content.gallery.items.map((item) => ["gallery-" + item.id, item.visual.alt]),
        ["about", envelope.content.about.portrait.alt],
      ]);
      return {
        count: images.length,
        loaded: images.every((image) => image.complete && image.naturalWidth > 0),
        sourceMatches: images.every((image) => image.getAttribute("src") === ${JSON.stringify(uploadedPath)}),
        altMatches: images.every((image) => image.getAttribute("alt") === expected.get(image.dataset.editorialMedia)),
        surfaces: images.map((image) => image.dataset.editorialMedia),
      };
    })()`, true),
    "published public media images",
    45_000,
  );
  assert(publicResult.loaded, "one or more public images did not decode successfully");
  assert(publicResult.sourceMatches, "the public renderer changed a managed media path");
  assert(publicResult.altMatches, "public image alt text does not match published content");

  const mediaHttp = await fetch(`${origin}${uploadedPath}`);
  const mediaBytes = await mediaHttp.arrayBuffer();
  assert(mediaHttp.status === 200, `managed image returned HTTP ${mediaHttp.status}`);
  assert(mediaHttp.headers.get("content-type") === "image/png", "managed image did not retain its verified MIME type");
  assert(mediaBytes.byteLength > 0, "managed image response was empty");
  assert(
    mediaResponses.some((response) => response.url === `${origin}${uploadedPath}` && response.status === 200 && response.mimeType === "image/png"),
    "Chrome recorded no successful managed-image response",
  );

  cdp.close();
  process.stdout.write("media pipeline browser proof: PASS\n");
  process.stdout.write(`managed path: ${uploadedPath}\n`);
  process.stdout.write("admin: upload selected; draft saved; draft published\n");
  process.stdout.write(`preview: ${previewResult.count}/11 images decoded with contract alt text\n`);
  process.stdout.write(`public: ${publicResult.count}/11 images decoded from the published managed path\n`);
  process.stdout.write(`surfaces: ${publicResult.surfaces.join(", ")}\n`);
  process.stdout.write(`fallbacks: ${initialFallbacks}/11 null fallbacks; broken Hero path recovered\n`);
  process.stdout.write(`image HTTP: 200 image/png (${mediaBytes.byteLength} bytes)\n`);
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  await stopProcess(chrome, chrome ? new Promise((resolveExit) => chrome.once("exit", resolveExit)) : null);
  await stopProcess(phpServer, phpServerExit);
  if (mysqlContainer) spawnSync("docker", ["rm", "--force", mysqlContainer], { stdio: "ignore" });
  if (uploadedPath && /^\/media\/med_[0-9a-f]{32}\.(?:jpg|png|webp)$/.test(uploadedPath)) {
    rmSync(join(repoRoot, "front", "out", uploadedPath), { force: true });
  }
  if (!exportedMediaExisted) rmSync(exportedMediaRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
}

if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  process.exit(1);
}
