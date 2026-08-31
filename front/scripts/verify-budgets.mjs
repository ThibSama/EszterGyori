#!/usr/bin/env node
/**
 * ESZ-085 — regression budgets over the built export.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is not a performance audit and it does not claim a Lighthouse score: there is
 * no browser runner in this repository, and inventing one of those numbers would be
 * worse than not having it. `docs/v1-quality-gates.md` keeps the browser gates at
 * NOT RUN for exactly that reason, and this gate does not change that.
 *
 * What it is: a *ratchet*. Every budget below sits just above what the current
 * build actually produces, so the gate is silent today and speaks the moment
 * something grows. That is the regression worth catching automatically — a
 * dependency added to a shared layout, a chart library pulled into the admin
 * bundle, an image inlined as a data URI — because each of those is invisible in
 * review and permanent once shipped.
 *
 * Budgets that merely restate the framework's own weight would prove nothing, so
 * the headroom is deliberately small: a few per cent, not a doubling. A change
 * needing more is a change someone should have to justify by editing this file.
 *
 * ## Gzip, because that is what is transferred
 *
 * Every measurement is `gzip -9` of the bytes the browser fetches. Raw size is the
 * wrong unit for a budget — minified JavaScript compresses about four to one, so
 * raw numbers overstate the cost of code and understate the cost of anything
 * already compressed, such as an inlined image.
 *
 * Run with `npm run verify:budgets` after `npm run build`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const frontRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(frontRoot, "out");

/**
 * Per-route ceilings on what a first visit transfers, in gzipped bytes.
 *
 * `total` is the document plus every stylesheet and script it references. It is
 * the number that decides how long someone stares at nothing, which is why the
 * budget is on the total rather than on a bundle nobody experiences in isolation.
 *
 * `html` is called out separately for `/` alone. The public page is the one
 * document PHP rewrites on every request (ESZ-021), so it is never cached as a
 * document and its size is paid on every single visit — a distinction none of the
 * other routes have.
 */
const routeBudgets = [
  {
    route: "index.html",
    total: 300_000,
    html: 14_000,
    note: "The public page. Its HTML is re-injected per request and never document-cached.",
  },
  { route: "reservation.html", total: 300_000, note: "The public booking flow (ESZ-050)." },
  { route: "admin.html", total: 315_000, note: "The admin shell." },
  { route: "admin/bookings.html", total: 300_000, note: "The booking calendar (ESZ-061)." },
  { route: "admin/availability.html", total: 300_000, note: "The availability editor (ESZ-063/064)." },
  { route: "admin/login.html", total: 295_000, note: "The one route an unauthenticated person reaches." },
];

/**
 * The shared cost every route pays, measured once.
 *
 * Broken out because a regression here is the expensive kind: it lands on all six
 * routes at once, and against a per-route total it looks like six small
 * regressions rather than one large one.
 */
const sharedBudgets = { css: 15_000, totalJavaScript: 345_000 };

const failures = [];
const reported = [];

function gzipped(path) {
  return gzipSync(readFileSync(path), { level: 9 }).length;
}

function assetsOf(routePath) {
  const html = readFileSync(routePath, "utf8");

  return new Set(
    [...html.matchAll(/(?:src|href)="(\/_next\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]),
  );
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];

  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)];
  });
}

function budget(label, actual, ceiling, note = "") {
  const percent = ((actual / ceiling) * 100).toFixed(0);
  reported.push(
    `  ${actual <= ceiling ? "ok  " : "OVER"} ${label.padEnd(32)} ${String(actual).padStart(8)} / ${String(ceiling).padStart(8)} B gz  (${percent}%)`,
  );

  if (actual > ceiling) {
    failures.push(
      `${label} is ${actual} gzipped bytes, over its ${ceiling} byte budget by ${actual - ceiling}.` +
        (note ? `\n           ${note}` : "") +
        "\n           If the growth is intended, raise the budget in front/scripts/verify-budgets.mjs" +
        "\n           in the same commit, so the increase is reviewed rather than absorbed.",
    );
  }
}

if (!existsSync(outDir)) {
  console.error("verify-budgets: out/ is missing. Run `npm run build` first.");
  process.exit(1);
}

for (const { route, total, html, note } of routeBudgets) {
  const routePath = join(outDir, route);

  if (!existsSync(routePath)) {
    failures.push(
      `${route} is not in out/; a budget cannot be checked against a route that did not build.`,
    );
    continue;
  }

  const documentBytes = gzipped(routePath);
  let assetBytes = 0;

  for (const asset of assetsOf(routePath)) {
    const assetPath = join(outDir, asset.slice(1));
    if (existsSync(assetPath)) assetBytes += gzipped(assetPath);
  }

  budget(route, documentBytes + assetBytes, total, note);

  if (html !== undefined) budget(`${route} (document only)`, documentBytes, html, note);
}

const buildAssets = walk(join(outDir, "_next")).map((name) => join(outDir, "_next", name));

budget(
  "all CSS",
  buildAssets.filter((path) => path.endsWith(".css")).reduce((sum, path) => sum + gzipped(path), 0),
  sharedBudgets.css,
  "A stylesheet regression lands on every route at once.",
);

budget(
  "all JavaScript",
  buildAssets.filter((path) => path.endsWith(".js")).reduce((sum, path) => sum + gzipped(path), 0),
  sharedBudgets.totalJavaScript,
  "The whole shipped bundle, so a new dependency is visible even if no single route grew much.",
);

process.stdout.write("verify-budgets: gzipped transfer against declared ceilings\n");
process.stdout.write(reported.join("\n") + "\n");

if (failures.length > 0) {
  process.stderr.write(`\nverify-budgets: ${failures.length} budget(s) exceeded\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`\nverify-budgets: ${reported.length} budget(s) within their ceilings\n`);
