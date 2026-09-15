#!/usr/bin/env node
/**
 * ESZ-085 — regression budgets over the built export.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is not a performance audit and it does not claim a Lighthouse score: it
 * measures bytes over built artifacts, and inventing a browser number here would
 * be worse than not having it. Real-browser lab measurements of FCP/LCP/CLS on
 * the public page live in the `browser:public` runner (ESZ-113) and
 * `docs/performance-audit.md`; neither is a field Core Web Vitals claim.
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
  { route: "admin/bookings.html", total: 309_000, note: "The booking calendar (ESZ-061)." },
  { route: "admin/availability.html", total: 309_000, note: "The availability editor (ESZ-063/064)." },
  { route: "admin/login.html", total: 295_000, note: "The one route an unauthenticated person reaches." },
];

/**
 * The shared cost every route pays, measured once.
 *
 * Broken out because a regression here is the expensive kind: it lands on all six
 * routes at once, and against a per-route total it looks like six small
 * regressions rather than one large one.
 */
/*
 * The CSS budget moved from 15 000 to 16 000 gzipped bytes in ESZ-158, which
 * added the admin visual system to `globals.css`: a token scope, the component
 * classes the shell, the overview and the CMS are built from, and the scoped
 * remap that keeps the transitional Package 10.2 pages in the same palette
 * without redesigning them.
 *
 * Measured over the built export, gzip -9, summing every stylesheet under
 * `out/_next` — which is one file:
 *
 *   14 367 B  the parent commit, caf4ed19, built clean;
 *   14 386 B  this branch with the admin block removed from `globals.css`
 *             (+19 B: the Tailwind utilities the new admin components pull in);
 *   15 627 B  this branch as it ships.
 *
 * So the admin block itself costs +1 241 B and ESZ-158 costs +1 260 B in total.
 * That leaves 373 B under the new ceiling, which keeps the ratchet tight: the
 * budget still sits just above what the build produces and speaks on the next
 * unexplained growth.
 *
 * It is a real cost on the public routes, which download the admin rules they
 * never match — one stylesheet serves the whole export. It is accepted here
 * rather than absorbed silently, and the honest way to give it back is to split
 * the admin stylesheet off the public one, which is its own piece of work.
 *
 * Package 10.2 (ESZ-149 to ESZ-160) moved both shared ceilings once more, at
 * the package-wide gate on top of fff3506: CSS from 16 000 to 17 000 and
 * JavaScript from 345 000 to 355 000 gzipped bytes. Measured the same way:
 *
 *   16 574 B  all CSS         (+947 B over the ESZ-158 build);
 *  353 127 B  all JavaScript  (+8 127 B, about 2.4 %).
 *
 * No dependency changed across the package — the only lockfile movement since
 * ESZ-158 is the `next` 16.3.2 → 16.3.3 security patch — and no unreferenced
 * asset landed in the export. The growth is the product: the unified Calendar
 * (ESZ-159), the administrable catalog and combinations (ESZ-149/150), the
 * booking time rules and planning constraints (ESZ-151/152), the slot-coherence
 * copy (ESZ-153) and the two-field identity form (ESZ-160). Each ceiling sits a
 * few hundred bytes above what the build produces, so the ratchet keeps
 * speaking on the next unexplained growth; the per-route totals were not moved.
 *
 * Package 10.3 (ESZ-161 to ESZ-166) moved the JavaScript ceiling from 355 000
 * to 381 000 gzipped bytes and, for the first time, two per-route totals: the
 * booking calendar and the availability editor from 300 000 to 305 000 each.
 * Measured the same way, at the package-wide gate on top of 0bfbca07:
 *
 *  380 469 B  all JavaScript            (+27 342 B over the 10.2 build);
 *  304 612 B  admin/bookings.html       total;
 *  304 626 B  admin/availability.html   total.
 *
 * The acceptance correction then let the public footer links wrap at 320 px,
 * which ships as 380 479 / 304 619 / 304 634 B — a few bytes of class names,
 * still under the same ceilings.
 *
 * No frontend dependency changed and the lockfile did not move. The growth is
 * the product: the admin GDPR request centre (ESZ-163/164), the legal settings
 * (ESZ-165) and the two public legal pages. The two admin routes crossed their
 * ceiling through what every admin route imports — the shared admin API client
 * and the shell navigation that now carries Settings — not through anything
 * they render themselves. Each ceiling again sits a few hundred bytes above the
 * build, so the ratchet keeps speaking; CSS and the other route totals were not
 * moved.
 *
 * Package 10.4 (the V1 visual polish) moves CSS from 17 000 to 21 000 and
 * JavaScript from 381 000 to 388 000 gzipped bytes, and the same two admin
 * route totals from 305 000 to 309 000 each. Measured the same way, on the
 * acceptance-corrected candidate on top of c44f5176:
 *
 *                              10.3          10.4        delta
 *   all CSS                  16 574 B      20 495 B     +3 921 B  (+23.7 %)
 *   all JavaScript          380 479 B     387 395 B     +6 916 B   (+1.8 %)
 *   admin/bookings.html     304 619 B     308 420 B     +3 801 B   (+1.2 %)
 *   admin/availability.html 304 634 B     308 434 B     +3 800 B   (+1.2 %)
 *
 * No frontend dependency changed and neither package.json nor the lockfile moved
 * anywhere in the package — `git diff 0bfbca07..HEAD -- '*package.json'
 * '*package-lock.json'` is empty — so none of this is a library that arrived
 * unnoticed. The growth is the reviewed product work: the visual system in
 * `globals.css` (the ambient light fields, the section tints, the polish
 * surface/card/media treatments and the CSS-only grain, which is nearly all of
 * the CSS delta on its own), the extracted `SiteFooter` and editorial
 * fallbacks, the administrable services and default-allow booking combinations,
 * and the reservation detail work. The two admin routes again crossed through
 * what every admin route imports rather than through anything they render
 * themselves.
 *
 * The CSS ceiling is the one that moved by a visible proportion, and it is worth
 * naming why: one stylesheet still serves the whole export, so the public routes
 * download admin rules they never match. That was already true at ESZ-158 and
 * the remedy is unchanged — split the admin stylesheet off the public one, which
 * remains its own piece of work. The grain in that stylesheet is CSS-only by
 * requirement, not by preference: its `data:image/svg+xml` predecessor was
 * refused by the enforced public `img-src` CSP, and the CSP was not weakened to
 * keep it.
 *
 * Each new ceiling again sits a few hundred bytes above the build (505 B on CSS,
 * 605 B on JavaScript, 580 and 566 B on the two routes), so the ratchet stays
 * tight; the other route totals were not moved.
 */
const sharedBudgets = { css: 21_000, totalJavaScript: 388_000 };

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
