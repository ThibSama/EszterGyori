#!/usr/bin/env node
/**
 * ESZ-020 — proves the production frontend needs no Node.
 *
 * `next build` succeeding under `output: "export"` already rules out most of what
 * this checks. The reason to check anyway is that the flag can be removed in one
 * line, and the failure that follows is not a build error — it is a deploy that
 * looks fine locally and 404s or 500s on a host with no Node process. The gate
 * turns "someone would have to notice" into "the pipeline stops".
 *
 * Read as a list of claims, this asserts:
 *
 *   1. the build declared itself an export, with no middleware and no dynamic route;
 *   2. every route the app exposes reached `out/` as a file;
 *   3. nothing in the tree can request server behaviour — no route handler, no
 *      middleware entry point, no server-only dependency;
 *   4. `out/index.html` carries a usable bootstrap payload and a colours-only
 *      appearance block, which is what ESZ-021's PHP injection rewrites.
 *
 * Run with `npm run verify:export` after `npm run build`.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(frontRoot, "out");
const buildDir = join(frontRoot, ".next");

const failures = [];
const checks = [];

function check(claim, condition, detail = "") {
  checks.push(claim);
  if (!condition) failures.push(detail ? `${claim}\n           ${detail}` : claim);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)];
  });
}

// ── 1. The build declared itself an export ──────────────────────────────────
if (!existsSync(outDir)) {
  console.error("verify-export: out/ is missing. Run `npm run build` first.");
  process.exit(1);
}

const exportMarker = readJson(join(buildDir, "export-marker.json"));
check(
  "the build emitted an export marker",
  exportMarker.version === 1,
  `export-marker.json: ${JSON.stringify(exportMarker)}`,
);
check(
  "trailingSlash is false, matching the .htaccess rewrite rules",
  exportMarker.exportTrailingSlash === false,
  "docs/hetzner-target-architecture.md §12: the two must agree or production redirect-loops.",
);
check(
  "no next/image optimisation is required",
  exportMarker.isNextImageImported === false,
  "There is no image optimiser on the target host.",
);

const routes = readJson(join(buildDir, "routes-manifest.json"));
check(
  "no dynamic route survived the build",
  routes.dynamicRoutes.length === 0,
  `dynamicRoutes: ${JSON.stringify(routes.dynamicRoutes)}`,
);
check(
  "the build requests no rewrites of its own",
  ["beforeFiles", "afterFiles", "fallback"].every(
    (phase) => routes.rewrites[phase].length === 0,
  ),
  "Rewrites are Apache's job on the target host; a Next rewrite would not exist there.",
);
check(
  "the build requests no redirects of its own",
  routes.redirects.filter((redirect) => !redirect.internal).length === 0,
);

const middlewarePath = join(buildDir, "server", "middleware-manifest.json");
const middleware = existsSync(middlewarePath)
  ? readJson(middlewarePath)
  : { middleware: {}, functions: {} };
check(
  "no middleware or edge function is registered",
  Object.keys(middleware.middleware).length === 0 &&
    Object.keys(middleware.functions).length === 0,
  `middleware-manifest.json: ${JSON.stringify(middleware)}`,
);

const prerender = readJson(join(buildDir, "prerender-manifest.json"));
check(
  "no route is left to render on demand",
  Object.keys(prerender.dynamicRoutes).length === 0,
  `dynamicRoutes: ${Object.keys(prerender.dynamicRoutes).join(", ")}`,
);

// ── 2. Every route reached out/ as a file ───────────────────────────────────
const expectedFiles = [
  "index.html",
  "404.html",
  "admin.html",
  join("admin", "login.html"),
  join("admin", "preview.html"),
  "reservation.html",
  "robots.txt",
  "sitemap.xml",
  "manifest.webmanifest",
];

for (const file of expectedFiles) {
  check(`out/${file.replace(/\\/g, "/")} was exported`, existsSync(join(outDir, file)));
}

// ── 3. Nothing can ask for server behaviour ─────────────────────────────────
const sourceFiles = walk(join(frontRoot, "app")).map((path) => path.replace(/\\/g, "/"));

const routeHandlers = sourceFiles.filter((path) => /(^|\/)route\.(ts|tsx|js|jsx)$/.test(path));
check(
  "no route handler remains under app/",
  routeHandlers.length === 0,
  `A route handler is a server endpoint: ${routeHandlers.join(", ")}`,
);

const middlewareEntry = ["proxy.ts", "middleware.ts", "proxy.js", "middleware.js"].filter(
  (name) => existsSync(join(frontRoot, name)),
);
check(
  "no middleware entry point remains",
  middlewareEntry.length === 0,
  `Middleware cannot run on static hosting: ${middlewareEntry.join(", ")}`,
);

const packageJson = readJson(join(frontRoot, "package.json"));
const serverOnlyDependencies = ["server-only", "jose"].filter(
  (name) => name in (packageJson.dependencies ?? {}),
);
check(
  "no server-only production dependency remains",
  serverOnlyDependencies.length === 0,
  `Retired with the Node runtime: ${serverOnlyDependencies.join(", ")}`,
);
check(
  "there is no `next start` script to run",
  !("start" in (packageJson.scripts ?? {})),
  "`next start` boots a Node server; the target host has none.",
);

const serverImports = sourceFiles
  .filter((path) => /\.(ts|tsx)$/.test(path))
  .map((path) => [path, readFileSync(join(frontRoot, "app", path), "utf8")])
  .filter(([, source]) => /from "(server-only|next\/headers|next\/server)"/.test(source))
  .map(([path]) => path);
check(
  "no module imports a server-only Next API",
  serverImports.length === 0,
  `next/headers, next/server and server-only need a request: ${serverImports.join(", ")}`,
);

// ── 4. The injection boundary is present and usable ─────────────────────────
const indexHtml = readFileSync(join(outDir, "index.html"), "utf8");

function elementContents(tag, id) {
  const pattern = new RegExp(`<${tag}[^>]*id="${id}"[^>]*>([\\s\\S]*?)</${tag}>`);
  return pattern.exec(indexHtml)?.[1] ?? null;
}

const payload = elementContents("script", "__ESZTER_CONTENT__");
check(
  "out/index.html carries the content bootstrap element",
  payload !== null,
  "PHP locates this element by id to inject published content (ESZ-021).",
);

let envelope = null;
if (payload !== null) {
  try {
    envelope = JSON.parse(payload);
  } catch (error) {
    check("the baked payload is parseable JSON", false, String(error));
  }
}

if (envelope) {
  check("the baked payload is parseable JSON", true);
  check(
    "the baked payload is the canonical unpublished envelope",
    envelope.schemaVersion === 1 && envelope.revision === 0 && envelope.publishedAt === null,
    `revision ${envelope.revision}, publishedAt ${envelope.publishedAt}`,
  );
  check(
    "the baked payload carries real content, not a placeholder",
    typeof envelope.content?.hero?.description === "string" &&
      envelope.content.hero.description.length > 0,
  );
}

check(
  "no raw <, > or & survives inside the payload",
  payload !== null && !/[<>&]/.test(payload),
  "An editorial string could otherwise terminate the script element.",
);

const appearance = elementContents("style", "__ESZTER_APPEARANCE__");
check(
  "out/index.html carries the appearance bootstrap element",
  appearance !== null,
);
check(
  "the appearance block is CSS custom properties and hex colours only",
  appearance !== null &&
    /^:root\{(--site-[a-z-]+:#[0-9A-F]{6};)*--site-[a-z-]+:#[0-9A-F]{6}\}$/.test(appearance),
  `page.appearanceIsColoursOnly. Got: ${appearance?.slice(0, 120)}`,
);

// The exported file must stand on its own: if PHP never touches it, a crawler
// still gets the real French copy rather than an empty shell.
check(
  "the exported HTML renders its content without JavaScript",
  envelope !== null && indexHtml.includes(envelope.content.hero.description.slice(0, 40)),
  "The body markup must already contain the copy; a blank shell was the rejected design.",
);

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`verify-export: ${failures.length} of ${checks.length} checks failed\n`);
  for (const failure of failures) console.error(`  FAIL     ${failure}`);
  process.exit(1);
}

console.log(`verify-export: ${checks.length} checks passed; out/ is deployable without Node.`);
