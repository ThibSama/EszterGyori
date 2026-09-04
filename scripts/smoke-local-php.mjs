#!/usr/bin/env node

// Local PHP smoke (stage-8 gate `smoke:local-php`). The `/api/health` wait
// below is a LIVENESS wait: health reads no file, takes no lock and touches no
// database, so a 200 proves only that the PHP service can boot and answer.
// This smoke then proves the live static HTTP surface (public pages, assets,
// routing, no PHP fatal). It deliberately does NOT claim composed-product
// readiness — published-content envelope and booking/MySQL are outside it.
// Readiness is the separate project probe `scripts/readiness.mjs` (ESZ-127),
// and the full-stack smoke proves the composed product through its own MySQL/
// auth/booking flow.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, host, () => {
    const address = probe.address();
    const selected = typeof address === "object" && address ? address.port : null;
    probe.close((error) => error ? reject(error) : resolvePort(selected));
  });
});

if (!Number.isInteger(port)) throw new Error("Could not reserve a local smoke-test port.");

let output = "";
const child = spawn(
  "node",
  ["scripts/serve-php.mjs", "--skip-build", "--skip-bootstrap", `--host=${host}`, `--port=${port}`],
  { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output = (output + chunk).slice(-64_000);
  });
}

const baseUrl = `http://${host}:${port}`;
const deadline = Date.now() + 15_000;
let health;

try {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Development server exited with ${child.exitCode}.`);
    try {
      health = await fetch(`${baseUrl}/api/health`);
      if (health.status === 200) break;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  if (!health || health.status !== 200) {
    throw new Error("Development server did not become live (/api/health never answered 200 within 15 s).");
  }
  const healthBody = await health.json();
  if (healthBody.status !== "ok" || healthBody.service !== "eszter-api") {
    throw new Error(`Unexpected health response: ${JSON.stringify(healthBody)}`);
  }

  const home = await fetch(`${baseUrl}/`);
  const homeBody = await home.text();
  if (home.status !== 200) throw new Error(`GET / returned ${home.status}.`);
  if (!home.headers.get("content-type")?.startsWith("text/html")) {
    throw new Error(`GET / returned ${home.headers.get("content-type")}.`);
  }
  if (!homeBody.includes("__ESZTER_CONTENT__") || !homeBody.includes("Eszter Gyori")) {
    throw new Error("GET / did not return the expected Eszter public page.");
  }

  const reservation = await fetch(`${baseUrl}/reservation`);
  const reservationBody = await reservation.text();
  if (reservation.status !== 200) throw new Error(`GET /reservation returned ${reservation.status}.`);
  if (
    !reservation.headers.get("content-type")?.startsWith("text/html")
    || !reservationBody.includes('id="reservation-main"')
    || !reservationBody.includes("Choisissez votre prestation et votre créneau")
  ) {
    throw new Error("GET /reservation did not return the reservation interface.");
  }

  const canonical = await fetch(`${baseUrl}/reservation.html`, { redirect: "manual" });
  if (canonical.status !== 301 || canonical.headers.get("location") !== "/reservation") {
    throw new Error(`GET /reservation.html did not redirect canonically (${canonical.status}).`);
  }

  const reservationAssetPath = "/reservation/__next.reservation.__PAGE__.txt";
  const reservationAsset = await fetch(`${baseUrl}${reservationAssetPath}`);
  if (reservationAsset.status !== 200 || (await reservationAsset.arrayBuffer()).byteLength === 0) {
    throw new Error(`Reservation asset ${reservationAssetPath} did not resolve successfully.`);
  }

  const assetPath = /(?:src|href)="(\/_next\/static\/[^"?]+\.(?:css|js|woff2))/.exec(homeBody)?.[1];
  if (!assetPath) throw new Error("Could not find a generated frontend asset in GET /.");
  const asset = await fetch(`${baseUrl}${assetPath}`);
  if (asset.status !== 200 || (await asset.arrayBuffer()).byteLength === 0) {
    throw new Error(`Frontend asset ${assetPath} did not resolve successfully.`);
  }

  const unknownPage = await fetch(`${baseUrl}/route-that-does-not-exist`);
  const unknownPageBody = await unknownPage.text();
  if (unknownPage.status !== 404 || !unknownPageBody.includes("404")) {
    throw new Error(`Unknown public route returned ${unknownPage.status} without the exported 404 page.`);
  }

  const unknownApi = await fetch(`${baseUrl}/api/route-that-does-not-exist`);
  const unknownApiBody = await unknownApi.json();
  if (unknownApi.status !== 404 || unknownApiBody?.error?.code !== "NOT_FOUND") {
    throw new Error(`Unknown API route violated the JSON 404 contract: ${unknownApi.status}.`);
  }

  if (/PHP (?:Fatal error|Warning)|Failed opening required/.test(output)) {
    throw new Error("The development server logged a PHP routing/bootstrap failure.");
  }

  process.stdout.write(
    `php local smoke: server live at ${baseUrl}; liveness + static HTTP surface: 9 checks passed `
      + `(GET / 200, GET /reservation 200, GET /reservation.html 301, `
      + `${reservationAssetPath} 200, ${assetPath} 200, GET /api/health 200, `
      + `public/API unknown routes 404, no PHP fatal). `
      + `Readiness (published envelope, booking/MySQL) is not part of this smoke.\n`,
  );
} catch (error) {
  process.stderr.write(`php local smoke: FAIL: ${error.message}\n${output}\n`);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
