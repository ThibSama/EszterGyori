#!/usr/bin/env node
/**
 * ESZ-114 — `smoke:apache`: prove Apache parity from the PACKAGED artifact.
 *
 * The committed `.htaccess` files own API/public/admin routing, private-file
 * denial, CSP and the security headers; the ESZ-113 browser gates already run
 * real Apache, but their fixture copies `front/out` and the source `php/public`
 * directly. This gate serves the *packaged production artifact* instead:
 *
 *   1. builds and attests `dist/eszter-production.tar.gz` (ESZ-126 provenance:
 *      packaging requires a clean committed candidate, and the verifier attests
 *      the archive manifest against this checkout's HEAD);
 *   2. extracts it to disposable storage and verifies the untouched artifact
 *      (manifest digests + provenance) before anything writes into it;
 *   3. serves the extracted layout the way the runbook deploys it — the whole
 *      release tree mounted at `/var/www` so that `public_html` is the Apache
 *      document root, `app/` is its private sibling runtime, and `config/`,
 *      `data/`, `var/` are the disposable runtime roots — and proves through
 *      real Apache, with no mock and nothing leaving 127.0.0.1:
 *        a. `/` reaches the PHP content injection and `/index.html` redirects
 *           to `/`;
 *        b. `/reservation` resolves, `/reservation.html` canonicalises, and
 *           exported admin pages plus an unknown admin deep link reach the
 *           admin shell;
 *        c. unknown public routes keep the HTML 404 and unknown `/api/*` keeps
 *           the JSON API 404 envelope;
 *        d. hashed static assets are served directly with immutable caching;
 *        e. responses carry the committed CSP, X-Content-Type-Options,
 *           Referrer-Policy, X-Frame-Options, Permissions-Policy and the
 *           disclosure policy (X-Powered-By absent; the Apache `Server` banner
 *           is core-emitted and host-controlled — see the generated .htaccess);
 *   4. re-extracts a disposable COPY and plants inert canaries so the deny
 *      rules are proved as 403 policy rather than as 404 absence — `.env`,
 *      `.git/config`, Composer/package manifests, denied extensions — and
 *      proves the media whitelist: managed `med_<32 hex>.(jpg|png|webp)` names
 *      are served with immutable + nosniff + inline headers while non-managed
 *      and PHP-like files are denied and never executed;
 *   5. runs a small real-Chrome pass against the extracted artifact — public
 *      page, reservation and admin login/deep link under ONE Apache origin
 *      (with the disposable MySQL behind the admin session bootstrap) — and
 *      asserts no same-origin critical asset is blocked by CSP.
 *
 * Everything is disposable and removed on PASS, on failure and on
 * interruption: Apache/MySQL containers, network, Chrome profile, extractions
 * and the whole scratch roots. The persistent `eszter_dev` deployment is never
 * created, read or reset.
 *
 * Environment seams (never active in a canonical run):
 *   ESZTER_SMOKE_APACHE_SKIP_BUILD=1   reuse the existing dist artifact (the
 *                                      provenance attestation still runs and the
 *                                      packaged commit must still equal HEAD);
 *   ESZTER_SMOKE_APACHE_FAIL_STEP=after-stack  throw once the first stack is
 *                                      live (focused runner cleanup tests);
 *   ESZTER_SMOKE_APACHE_CHROME=<binary>  chrome override (default google-chrome);
 *   ESZTER_SMOKE_APACHE_IMAGE=<image>    Apache/PHP image override
 *                                      (default esz104-apache:local, built once).
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  repoRoot,
  makeProof,
  run,
  runIgnoringExit,
  waitFor,
  launchChrome,
  evaluate,
  stopProcessQuietly,
} from "./browser-stack.mjs";
import { resolveHeadCommit } from "./production-provenance.mjs";

const CANONICAL_REPOSITORY = "ThibSama/EszterGyori";
const ARCHIVE_PATH = join(repoRoot, "dist", "eszter-production.tar.gz");
const ARTIFACT_DIR_NAME = "eszter-production";
const PHP_APACHE_IMAGE = process.env.ESZTER_SMOKE_APACHE_IMAGE ?? "esz104-apache:local";
const CHROME_BINARY = process.env.ESZTER_SMOKE_APACHE_CHROME ?? "google-chrome";
const SKIP_BUILD = process.env.ESZTER_SMOKE_APACHE_SKIP_BUILD === "1";
const FAIL_AFTER_STACK = process.env.ESZTER_SMOKE_APACHE_FAIL_STEP === "after-stack";

const { fail, assert } = makeProof("smoke:apache");
const identity = `esz114${randomBytes(3).toString("hex")}`;

// ── Tiny inert media canaries (real, browser-decodable 1x1 images) ─────────

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);
const TINY_WEBP = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IC4AAADwAQCdASoBAAEALmk0mk0iIiIiIgBoSygABc6zbAAA",
  "base64",
);

// ── Disposable stack ───────────────────────────────────────────────────────

const cleanupHooks = [];
let chromeHandle = null;
let interrupted = false;

function onSignal(signal) {
  if (interrupted) return;
  interrupted = true;
  process.stderr.write(`\napache smoke: ${signal} received — removing the disposable stack.\n`);
  for (const hook of cleanupHooks.reverse()) {
    try {
      hook();
    } catch {
      // best-effort on the interrupt path
    }
  }
  process.exit(130);
}

process.once("SIGINT", () => onSignal("SIGINT"));
process.once("SIGTERM", () => onSignal("SIGTERM"));

function ensureApacheImage() {
  if (runIgnoringExit("docker", ["image", "inspect", PHP_APACHE_IMAGE])) return;
  process.stdout.write("apache smoke: building the local Apache image (pdo_mysql + gd)…\n");
  const build = spawnSync(
    "docker",
    ["build", "-t", PHP_APACHE_IMAGE, "-"],
    {
      input: `FROM php:8.4-apache
RUN apt-get update && apt-get install -y --no-install-recommends gcc make libpng-dev libjpeg62-turbo-dev libwebp-dev zlib1g-dev \\
    && docker-php-ext-configure gd --with-jpeg --with-webp \\
    && docker-php-ext-install -j2 pdo_mysql gd \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*
`,
      encoding: "utf8",
    },
  );
  if (build.status !== 0) fail(`could not build ${PHP_APACHE_IMAGE}: ${build.stderr ?? build.stdout}`);
}

/**
 * Extracts the archive once into a fresh scratch root and returns
 * `{ workRoot, releaseRoot }` — `releaseRoot` is the artifact's own top-level
 * directory, exactly as the runbook extracts it.
 */
function extractRelease() {
  const workRoot = mkdtempSync(join(tmpdir(), `eszter-apache-${identity}-`));
  chmodSync(workRoot, 0o755);
  run("tar", ["-xzf", ARCHIVE_PATH, "-C", workRoot]);
  const releaseRoot = join(workRoot, ARTIFACT_DIR_NAME);
  assert(
    existsSync(join(releaseRoot, "public_html", "index.html")),
    `extraction produced no ${ARTIFACT_DIR_NAME}/public_html/index.html`,
  );
  return { workRoot, releaseRoot };
}

/** Writes the operator's `config/config.php` inside the release tree. */
function writeRuntimeConfig(releaseRoot, mysqlName) {
  const database = mysqlName
    ? [
        "  'database' => [",
        "    'dsn' => 'mysql:host=" + mysqlName + ";port=3306;dbname=" + mysqlName + "_proof;charset=utf8mb4',",
        "    'username' => '" + mysqlName + "_proof',",
        "    'password' => '" + mysqlName + "_db_only',",
        "    'connectTimeoutSeconds' => 5,",
        "  ],",
      ].join("\n")
    : "  // no database on this stack: no proved route touches one (the connection is lazy).";
  writeFileSync(
    join(releaseRoot, "config", "config.php"),
    `<?php
declare(strict_types=1);
return [
  'environment' => 'development',
  'logLevel' => 'debug',
  'paths' => [
    'content' => '/var/www/data/content',
    'tmp' => '/var/www/var/tmp',
    'locks' => '/var/www/data/locks',
    'log' => '/var/www/var/log',
    'contracts' => '/var/www/app/contracts',
    'mediaOriginals' => '/var/www/data/media-originals',
    'public' => '/var/www/public_html',
  ],
${database ?? ""}
  'session' => ['cookieSecure' => false, 'idleTimeoutSeconds' => 3600, 'absoluteTimeoutSeconds' => 43200],
];
`,
    { mode: 0o644 },
  );
}

/**
 * Boots one disposable Apache stack over one extracted release tree.
 *
 * The release tree is mounted AT `/var/www`, mirroring the runbook layout:
 * docroot = `/var/www/public_html`, app root = `/var/www/app`, operator config
 * = `/var/www/config/config.php` — the packaged front controller discovers all
 * three without any environment variable. Runtime-writable roots (`config`,
 * `data`, `var`, `public_html/media`) are handed to www-data inside the
 * container. When `withMysql` is set, one disposable MySQL 8.4 container is
 * created first on the same network so the packaged runtime can reach it by
 * name.
 */
async function bootStack({ tag, releaseRoot, withMysql }) {
  ensureApacheImage();
  const shortTag = tag.replace(/[^a-z0-9]/g, "");
  const networkName = withMysql ? `${shortTag}_net` : null;
  const apacheName = `${shortTag}_apache`;
  const mysqlName = withMysql ? `${shortTag}_mysql` : null;

  // The cleanup hook is registered before the first docker side effect, so a
  // failure at any point — network, MySQL, Apache, port publication,
  // readiness, chown — still removes every resource this stack created. The
  // chown-back runs while the Apache container is still alive: the runtime
  // roots were handed to www-data inside the container, and a host-side user
  // cannot delete files owned by that uid once the container is gone.
  const hostUid = process.getuid?.() ?? 1000;
  const hostGid = process.getgid?.() ?? 1000;
  const handle = {
    origin: null,
    shortTag,
    networkName,
    apacheName,
    mysqlName,
    releaseRoot,
  };
  cleanupHooks.push(() => {
    if (runIgnoringExit("docker", ["exec", apacheName, "chown", "-R", `${hostUid}:${hostGid}`, "/var/www"])) {
      // chown-back succeeded; the tree is host-removable again.
    }
    runIgnoringExit("docker", ["rm", "--force", apacheName]);
    if (mysqlName) runIgnoringExit("docker", ["rm", "--force", mysqlName]);
    if (networkName) runIgnoringExit("docker", ["network", "rm", networkName]);
    rmSync(dirname(releaseRoot), { recursive: true, force: true });
  });

  if (mysqlName) {
    run("docker", ["network", "create", networkName]);
    run("docker", [
      "run", "--detach", "--rm", "--name", mysqlName, "--network", networkName,
      "--env", "MYSQL_DATABASE", "--env", "MYSQL_USER", "--env", "MYSQL_PASSWORD", "--env", "MYSQL_ROOT_PASSWORD",
      "mysql:8.4",
    ], {
      env: {
        ...process.env,
        MYSQL_DATABASE: `${mysqlName}_proof`,
        MYSQL_USER: `${mysqlName}_proof`,
        MYSQL_PASSWORD: `${mysqlName}_db_only`,
        MYSQL_ROOT_PASSWORD: `${mysqlName}_root_only`,
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
    process.stdout.write(`apache smoke: container ${mysqlName}\n`);
  }

  const apacheArgs = [
    "run", "--detach", "--rm", "--name", apacheName,
    ...(networkName ? ["--network", networkName] : []),
    "--publish", "127.0.0.1::80",
    "--volume", `${releaseRoot}:/var/www`,
    PHP_APACHE_IMAGE,
    "sh", "-c",
    "a2enmod headers rewrite >/dev/null 2>&1 "
      + "&& sed -ri 's#/var/www/html#/var/www/public_html#g' /etc/apache2/sites-available/000-default.conf /etc/apache2/sites-enabled/000-default.conf "
      + "&& sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf /etc/apache2/sites-available/000-default.conf /etc/apache2/sites-enabled/000-default.conf "
      + "&& exec apache2-foreground",
  ];
  run("docker", apacheArgs);
  process.stdout.write(`apache smoke: container ${apacheName}\n`);

  const portOutput = await waitFor(
    () => run("docker", ["port", apacheName, "80/tcp"]),
    "Apache port publication",
  );
  const apachePort = /:(\d+)$/.exec(portOutput)?.[1];
  assert(apachePort, `could not parse Apache port from ${portOutput}`);
  const origin = `http://127.0.0.1:${apachePort}`;
  process.stdout.write(`apache smoke: origin ${origin}\n`);

  // Hand the runtime roots to the web user before any request can touch them.
  run("docker", ["exec", apacheName, "sh", "-c",
    "chown -R www-data:www-data /var/www/config /var/www/data /var/www/var /var/www/app /var/www/public_html/media"]);

  try {
    await waitFor(async () => (await fetch(`${origin}/api/health`)).status === 200, "Apache + packaged front controller", 60_000);
  } catch (readinessError) {
    let apacheLogs = "";
    try {
      apacheLogs = run("docker", ["logs", apacheName]);
    } catch {
      apacheLogs = "(no apache logs available)";
    }
    throw new Error(`${readinessError.message}\n--- apache logs ---\n${apacheLogs}`);
  }

  handle.origin = origin;
  return handle;
}

/** Applies the real migrations through the PACKAGED app/bin inside the container. */
function migrateStack(handle) {
  run("docker", ["exec", handle.apacheName, "php",
    "/var/www/app/bin/migrate.php", "--config=/var/www/config/config.php"]);
  // The migrator runs as root (docker exec) and may leave root-owned lock
  // files behind in the runtime roots; hand them back to the web user so the
  // first request cannot fail with STORAGE_LOCK_FAILED on a root-owned lock.
  run("docker", ["exec", handle.apacheName, "sh", "-c",
    "chown -R www-data:www-data /var/www/config /var/www/data /var/www/var /var/www/app /var/www/public_html/media"]);
}

// ── HTTP proof helpers ─────────────────────────────────────────────────────

async function fetchPath(origin, path, init = {}) {
  return fetch(`${origin}${path}`, { redirect: "manual", ...init });
}

function assertStatus(response, path, expected, extra = "") {
  assert(
    response.status === expected,
    `${path} returned HTTP ${response.status}${extra ? ` (${extra})` : ""}; expected ${expected}`,
  );
  return response;
}

async function expectDenied(origin, path, marker) {
  const response = await fetchPath(origin, path);
  assertStatus(response, path, 403, "the committed deny rules must refuse, not 404");
  const body = await response.text();
  assert(
    !body.includes(marker),
    `${path} leaked its canary content (${marker}) in a ${response.status} body`,
  );
  return response;
}

function expectHeader(response, path, name, expected) {
  const value = response.headers.get(name);
  assert(
    value === expected,
    `${path} ${name} is ${JSON.stringify(value)}; expected ${JSON.stringify(expected)}`,
  );
  return response;
}

/** The exact committed value of a generated header, parsed from the packaged .htaccess. */
function committedHeader(releaseRoot, headerName) {
  const htaccess = `${readFileSync(join(releaseRoot, "public_html", ".htaccess"), "utf8")}`;
  const match = new RegExp(`Header always set ${headerName} "([^"]+)"`).exec(htaccess);
  assert(match, `the packaged .htaccess declares no ${headerName}`);
  return match[1];
}

// ── Proofs on the untouched artifact (stack 1) ─────────────────────────────

async function proveRoutingAndHeaders(handle, releaseRoot) {
  const { origin } = handle;
  const committedCsp = committedHeader(releaseRoot, "Content-Security-Policy");
  const committedPermissions = committedHeader(releaseRoot, "Permissions-Policy");
  const immutable = "public, max-age=31536000, immutable";

  process.stdout.write("apache smoke: proving the untouched artifact under Apache…\n");

  // 1. `/` reaches the PHP content injection; /index.html canonicalises to /.
  const home = await fetchPath(origin, "/");
  assertStatus(home, "/", 200);
  assert(home.headers.get("content-type")?.startsWith("text/html"), "GET / is not HTML");
  const homeBody = await home.text();
  assert(homeBody.includes("__ESZTER_CONTENT__"), "GET / carries no injected content element");
  assert(homeBody.includes("Eszter Gyori"), "GET / does not render the Eszter page");

  const indexCanonical = await fetchPath(origin, "/index.html");
  assertStatus(indexCanonical, "/index.html", 301);
  // mod_rewrite may emit the Location in either absolute or root-relative
  // form; the promise is the path it redirects to.
  const indexLocation = indexCanonical.headers.get("location") ?? "";
  assert(
    new URL(indexLocation, origin).pathname === "/",
    `GET /index.html does not redirect to /: ${indexLocation}`,
  );

  // 2. /reservation resolves; /reservation.html canonicalises; exported admin
  //    pages and unknown admin deep links reach the admin shell.
  const reservation = await fetchPath(origin, "/reservation");
  assertStatus(reservation, "/reservation", 200);
  const reservationBody = await reservation.text();
  assert(
    reservationBody.includes('id="reservation-main"')
      && reservationBody.includes("Choisissez votre prestation"),
    "GET /reservation did not return the reservation interface",
  );

  const reservationCanonical = await fetchPath(origin, "/reservation.html");
  assertStatus(reservationCanonical, "/reservation.html", 301);
  const reservationLocation = reservationCanonical.headers.get("location") ?? "";
  assert(
    new URL(reservationLocation, origin).pathname === "/reservation",
    `GET /reservation.html does not canonicalise to /reservation: ${reservationLocation}`,
  );

  for (const exportedAdmin of ["/admin", "/admin/login", "/admin/preview", "/admin/bookings"]) {
    const admin = await fetchPath(origin, exportedAdmin);
    assertStatus(admin, exportedAdmin, 200, "an exported admin page must reach the admin export");
    assert(admin.headers.get("content-type")?.startsWith("text/html"), `${exportedAdmin} is not HTML`);
  }
  const adminShell = await fetchPath(origin, "/admin/unknown-deep-link-esz114");
  assertStatus(adminShell, "/admin/unknown-deep-link-esz114", 200, "an unknown admin deep link must serve the shell, not 404");
  assert(adminShell.headers.get("content-type")?.startsWith("text/html"), "the admin shell is not HTML");

  // 3. Unknown public route -> HTML 404; unknown /api/* -> JSON 404 envelope.
  const unknownPage = await fetchPath(origin, "/route-that-does-not-exist-esz114");
  assertStatus(unknownPage, "/route-that-does-not-exist-esz114", 404);
  assert(unknownPage.headers.get("content-type")?.startsWith("text/html"), "the public 404 is not HTML");
  assert((await unknownPage.text()).includes("404"), "the HTML 404 body is not the exported 404 document");

  const unknownApi = await fetchPath(origin, "/api/route-that-does-not-exist-esz114", {
    headers: { accept: "application/json" },
  });
  assertStatus(unknownApi, "/api/route-that-does-not-exist-esz114", 404);
  assert(unknownApi.headers.get("content-type")?.startsWith("application/json"), "the API 404 is not JSON");
  const unknownApiBody = JSON.parse(await unknownApi.text());
  assert(
    unknownApiBody?.error?.code === "NOT_FOUND" && typeof unknownApiBody.error.requestId === "string",
    `the API 404 envelope is wrong: ${JSON.stringify(unknownApiBody)}`,
  );

  const health = await fetchPath(origin, "/api/health");
  assertStatus(health, "/api/health", 200);
  assert(health.headers.get("content-type")?.startsWith("application/json"), "/api/health is not JSON");

  // 4. Hashed static assets are served directly with immutable caching; HTML
  //    documents are not.
  const assetPath = /(?:src|href)="(\/_next\/static\/[^"?]+\.(?:css|js|woff2))/.exec(homeBody)?.[1];
  assert(assetPath, "no generated hashed asset found in GET /");
  const asset = await fetchPath(origin, assetPath);
  assertStatus(asset, assetPath, 200);
  assert(Number(asset.headers.get("content-length") ?? "0") > 0, `${assetPath} is empty`);
  expectHeader(asset, assetPath, "cache-control", immutable);
  assert(unknownPage.headers.get("cache-control") === null, "an HTML document carries the immutable cache policy");

  // 5. Every response enforces the committed CSP, baseline headers,
  //    Permissions-Policy and the disclosure policy.
  for (const [path, response] of [
    ["/", home],
    ["/api/health", health],
    ["/route-that-does-not-exist-esz114", unknownPage],
    ["/reservation", reservation],
  ]) {
    expectHeader(response, path, "content-security-policy", committedCsp);
    expectHeader(response, path, "permissions-policy", committedPermissions);
    expectHeader(response, path, "x-content-type-options", "nosniff");
    expectHeader(response, path, "referrer-policy", "strict-origin-when-cross-origin");
    expectHeader(response, path, "x-frame-options", "SAMEORIGIN");
    assert(response.headers.get("x-powered-by") === null, `${path} still discloses X-Powered-By`);
  }
}

// ── Denial + media proofs on the canary copy (stack 2) ─────────────────────

function plantCanaries(releaseRoot) {
  const docRoot = join(releaseRoot, "public_html");
  const plant = (name, content) => {
    const path = join(docRoot, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o644 });
  };
  plant(".env", "ESZ114_CANARY_ENV");
  plant(".env.local", "ESZ114_CANARY_ENV_LOCAL");
  plant(".git/config", "ESZ114_CANARY_GIT_CONFIG");
  plant(".git/HEAD", "ref: refs/heads/esz114\n");
  plant("composer.json", "ESZ114_CANARY_COMPOSER");
  plant("composer.lock", "ESZ114_CANARY_COMPOSER_LOCK");
  plant("package.json", "ESZ114_CANARY_PACKAGE");
  plant("notes.md", "ESZ114_CANARY_NOTES_MD");
  plant("secret.json", '{"esz114":"canary"}');
  plant("shell.php", "<?php echo 'ESZ114_PHP_EXECUTED';");
  plant("shell.phtml", "<?php echo 'ESZ114_PHTML_EXECUTED';");

  const media = join(docRoot, "media");
  plant("media/med_0123456789abcdef0123456789abcdef.jpg", TINY_JPEG);
  plant("media/med_0123456789abcdef0123456789abcdee.png", TINY_PNG);
  plant("media/med_0123456789abcdef0123456789abcdf0.webp", TINY_WEBP);
  plant("media/portrait.jpg", "ESZ114_CANARY_MEDIA_PORTRAIT");
  plant(`media/.staging-${"a".repeat(32)}.jpg`, "ESZ114_CANARY_MEDIA_STAGING");
  plant("media/med_0123456789abcdef0123456789abcdf.jpeg", "ESZ114_CANARY_MEDIA_JPEG_EXT");
  plant("media/med_0123456789abcdef0123456789abcdf.php", "<?php echo 'ESZ114_MEDIA_PHP_EXECUTED';");
  plant("media/probe.php", "<?php echo 'ESZ114_MEDIA_PROBE_EXECUTED';");
  plant("media/probe.phtml", "<?php echo 'ESZ114_MEDIA_PHTML_EXECUTED';");
}

async function proveDenialsAndMedia(handle) {
  const { origin } = handle;
  process.stdout.write("apache smoke: proving the deny rules and the media whitelist on a disposable canary copy…\n");

  // 6. Representative planted .env / Git / Composer / denied-extension paths:
  //    403 proves the committed policy — not 404 absence — and the canary
  //    bytes never come back.
  await expectDenied(origin, "/.env", "ESZ114_CANARY_ENV");
  await expectDenied(origin, "/.env.local", "ESZ114_CANARY_ENV_LOCAL");
  await expectDenied(origin, "/.git/config", "ESZ114_CANARY_GIT_CONFIG");
  await expectDenied(origin, "/.git/HEAD", "esz114");
  await expectDenied(origin, "/composer.json", "ESZ114_CANARY_COMPOSER");
  await expectDenied(origin, "/composer.lock", "ESZ114_CANARY_COMPOSER_LOCK");
  await expectDenied(origin, "/package.json", "ESZ114_CANARY_PACKAGE");
  await expectDenied(origin, "/notes.md", "ESZ114_CANARY_NOTES_MD");
  await expectDenied(origin, "/secret.json", "canary");

  // PHP-like files under the document root are denied and never executed: the
  // body carries the Apache refusal, not the marker, and no X-Powered-By.
  for (const [path, marker] of [
    ["/shell.php", "ESZ114_PHP_EXECUTED"],
    ["/shell.phtml", "ESZ114_PHTML_EXECUTED"],
  ]) {
    const response = await expectDenied(origin, path, marker);
    assert(response.headers.get("x-powered-by") === null, `${path} executed PHP (X-Powered-By present)`);
  }

  // media/ — managed names are served with the committed immutable/nosniff/
  // inline headers; everything else is denied and never executed.
  const immutable = "public, max-age=31536000, immutable";
  for (const [name, contentType] of [
    ["med_0123456789abcdef0123456789abcdef.jpg", "image/jpeg"],
    ["med_0123456789abcdef0123456789abcdee.png", "image/png"],
    ["med_0123456789abcdef0123456789abcdf0.webp", "image/webp"],
  ]) {
    const path = `/media/${name}`;
    const response = await fetchPath(origin, path);
    assertStatus(response, path, 200);
    expectHeader(response, path, "content-type", contentType);
    expectHeader(response, path, "cache-control", immutable);
    expectHeader(response, path, "x-content-type-options", "nosniff");
    expectHeader(response, path, "content-disposition", "inline");
    assert(response.headers.get("x-powered-by") === null, `${path} was executed`);
  }

  for (const [name, marker] of [
    ["portrait.jpg", "ESZ114_CANARY_MEDIA_PORTRAIT"],
    [`.staging-${"a".repeat(32)}.jpg`, "ESZ114_CANARY_MEDIA_STAGING"],
    ["med_0123456789abcdef0123456789abcdf.jpeg", "ESZ114_CANARY_MEDIA_JPEG_EXT"],
    ["med_0123456789abcdef0123456789abcdf.php", "ESZ114_MEDIA_PHP_EXECUTED"],
    ["probe.php", "ESZ114_MEDIA_PROBE_EXECUTED"],
    ["probe.phtml", "ESZ114_MEDIA_PHTML_EXECUTED"],
  ]) {
    const path = `/media/${name}`;
    const response = await expectDenied(origin, path, marker);
    assert(response.headers.get("x-powered-by") === null, `${path} executed PHP (X-Powered-By present)`);
  }

  const directory = await fetchPath(origin, "/media/");
  assertStatus(directory, "/media/", 403, "directory listing is disabled under media/");
}

// ── Real-Chrome pass (stack 2, same origin) ────────────────────────────────

async function proveChromePass(handle) {
  const { origin, releaseRoot } = handle;
  process.stdout.write(`apache smoke: running the real-Chrome pass against ${origin}…\n`);

  const profile = join(dirname(releaseRoot), "chrome-profile");
  const browser = await launchChrome(CHROME_BINARY, profile);
  chromeHandle = browser;
  const { cdp } = browser;
  const violations = [];
  const cspFailures = [];
  const subresources = [];
  const failuresSeen = [];

  cdp.on("Log.entryAdded", ({ entry }) => {
    if (entry.source === "security" && /Content Security Policy/i.test(entry.text ?? "")) {
      violations.push(entry.text);
    }
  });
  cdp.on("Network.loadingFailed", (failure) => {
    if (failure.blockedReason === "csp") cspFailures.push({ url: failure.url ?? "" });
  });
  cdp.on("Network.responseReceived", (params) => {
    const { response } = params;
    if (response.status >= 400) failuresSeen.push({ url: response.url, status: response.status, type: params.type });
    if (response.url.startsWith(origin) && response.status === 200
      && ["Script", "Stylesheet", "Image", "Font"].includes(params.type)) {
      subresources.push(response.url);
    }
  });
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // Public page: hydrated and rendered, with its same-origin assets served.
  await cdp.send("Page.navigate", { url: `${origin}/` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && Boolean(document.querySelector("h1"))`),
    "public page",
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
  const homeState = await evaluate(cdp, `(() => ({
    title: document.title,
    text: (document.body?.innerText ?? "").slice(0, 300),
    scripts: [...document.scripts].map((s) => s.src).filter((src) => src.startsWith(${JSON.stringify(origin)})).length,
  }))()`);
  assert(homeState.title.includes("Eszter Gyori"), `public page title: ${homeState.title}`);
  assert(homeState.text.includes("Eszter Gyori"), "public page rendered no Eszter content");
  assert(homeState.scripts > 0, "public page loaded no same-origin script");
  assert(subresources.length >= 2, `the public page loaded fewer than 2 same-origin subresources (${subresources.length})`);

  // Reservation page.
  await cdp.send("Page.navigate", { url: `${origin}/reservation` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && Boolean(document.getElementById("reservation-main"))`),
    "reservation page",
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));

  // Admin login page — its hydrated form implies the real anonymous-session
  // bootstrap over the disposable MySQL succeeded.
  await cdp.send("Page.navigate", { url: `${origin}/admin/login` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === "complete" && Boolean(document.getElementById("admin-login-email"))`),
    "admin login page",
  );

  // Unknown admin deep link: the shell answers, and the client shows the
  // signed-out gate rather than an error.
  await cdp.send("Page.navigate", { url: `${origin}/admin/unknown-deep-link-esz114` });
  try {
    await waitFor(
      () => evaluate(cdp, `(() => {
        if (document.readyState !== "complete") return false;
        const text = document.body?.innerText ?? "";
        return document.querySelector("h1")?.textContent?.trim() === "Connexion requise"
          || text.includes("Adresse email");
      })()`),
      "admin deep-link gate",
    );
  } catch (gateError) {
    const state = await evaluate(cdp, `JSON.stringify({
      path: location.pathname,
      search: location.search,
      h1: document.querySelector("h1")?.textContent?.trim() ?? null,
      bodyHead: (document.body?.innerText ?? "").slice(0, 400),
    })`);
    throw new Error(`${gateError.message}; page state: ${state}; failing responses: ${JSON.stringify(failuresSeen)}`);
  }

  // CSP: no same-origin critical asset was blocked. The only violation the
  // export can legitimately produce is the benign zod v4 JIT probe of eval
  // (blockedURI "eval", try/catch fallback) — nothing may reference a
  // same-origin URL.
  const blockedSameOrigin = violations.filter((entry) => entry.includes(origin));
  assert(
    blockedSameOrigin.length === 0,
    `CSP blocked same-origin assets: ${JSON.stringify(blockedSameOrigin)}`,
  );
  const cspRequestFailures = cspFailures.filter((failure) => failure.url.startsWith(origin));
  assert(
    cspRequestFailures.length === 0,
    `Chrome reported CSP-blocked same-origin requests: ${JSON.stringify(cspRequestFailures)}`,
  );
  assert(
    subresources.length >= 2,
    `the Chrome pass loaded fewer than 2 same-origin subresources across the pages (${subresources.length})`,
  );
}

// ── Gate flow ──────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write(`apache smoke: identity ${identity}\n`);

  // 1. Build and attest the packaged artifact. build-production-artifact.mjs
  //    refuses anything but a clean committed candidate (ESZ-126); the
  //    verifier attests the archive manifest against this checkout's HEAD.
  if (SKIP_BUILD) {
    assert(existsSync(ARCHIVE_PATH), "dist/eszter-production.tar.gz is missing (ESZTER_SMOKE_APACHE_SKIP_BUILD=1 without a built artifact)");
  } else {
    process.stdout.write("apache smoke: building the production artifact…\n");
    run("node", ["scripts/build-production-artifact.mjs"]);
  }
  process.stdout.write("apache smoke: attesting the artifact provenance against HEAD…\n");
  run("node", ["scripts/verify-production-artifact.mjs"]);
  const head = resolveHeadCommit(repoRoot);

  // 2. Stack 1 — the untouched artifact. Verify the pristine extraction
  //    against the manifest (every file digest, mode and the provenance
  //    commit), then serve it and prove routing + headers. No database: none
  //    of these routes touches one, and the application connection is lazy.
  const stack1 = await extractRelease();
  process.stdout.write(`apache smoke: scratch runtime state under ${stack1.workRoot} — removed on every exit.\n`);
  process.stdout.write("apache smoke: verifying the untouched extraction (manifest digests + provenance)…\n");
  run("node", ["scripts/verify-production-artifact.mjs",
    "--artifact-root", stack1.releaseRoot,
    "--expect-repository", CANONICAL_REPOSITORY,
    "--expect-commit", head]);
  writeRuntimeConfig(stack1.releaseRoot, null);

  const handle1 = await bootStack({ tag: `${identity}a`, releaseRoot: stack1.releaseRoot, withMysql: false });
  process.stdout.write(`apache smoke: pristine stack live at ${handle1.origin}\n`);
  if (FAIL_AFTER_STACK) {
    throw new Error("apache smoke: FAIL — injected failure after the pristine stack came up");
  }
  await proveRoutingAndHeaders(handle1, stack1.releaseRoot);

  // 3. Stack 2 — a disposable extracted COPY with inert canaries planted, so
  //    the deny proofs distinguish 403 policy from 404 absence. The same stack
  //    gains the disposable MySQL (reachable by name on its network) and hosts
  //    the Chrome pass.
  const stack2 = await extractRelease();
  process.stdout.write(`apache smoke: scratch runtime state under ${stack2.workRoot} — removed on every exit.\n`);
  const mysqlName = `${identity}b_mysql`;
  plantCanaries(stack2.releaseRoot);
  writeRuntimeConfig(stack2.releaseRoot, mysqlName);

  const handle2 = await bootStack({ tag: `${identity}b`, releaseRoot: stack2.releaseRoot, withMysql: true });
  process.stdout.write(`apache smoke: canary stack live at ${handle2.origin}\n`);
  migrateStack(handle2);
  process.stdout.write("apache smoke: real migrations applied to the disposable MySQL through the packaged app/bin/migrate.php\n");
  await proveDenialsAndMedia(handle2);
  try {
    await proveChromePass(handle2);
  } catch (chromeError) {
    let diagnostics = "";
    try {
      diagnostics = run("docker", ["exec", handle2.apacheName, "sh", "-c",
        "tail -n 30 /var/www/var/log/app.log 2>/dev/null || true"]);
    } catch {
      diagnostics = "(no app log available)";
    }
    throw new Error(`${chromeError.message}\n--- packaged app log tail ---\n${diagnostics}`);
  }

  // 4. Cleanup is a proof, not a courtesy: PASS is printed only after every
  //    container, network, Chrome process and scratch root is gone.
  if (chromeHandle) {
    await stopProcessQuietly(chromeHandle.chrome);
    chromeHandle = null;
  }
  for (const hook of cleanupHooks.reverse()) hook();
  cleanupHooks.length = 0;

  process.stdout.write("smoke:apache: PASS — packaged artifact served and proved under real Apache (routing, headers, deny rules, media whitelist, real Chrome); every disposable resource removed.\n");
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  if (chromeHandle) {
    try {
      await stopProcessQuietly(chromeHandle.chrome);
    } catch {
      // best-effort
    }
  }
  for (const hook of cleanupHooks.reverse()) {
    try {
      hook();
    } catch {
      // best-effort
    }
  }
}

if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  process.stderr.write("apache smoke: FAIL — disposable stack removed.\n");
  process.exit(1);
}
