#!/usr/bin/env node

/**
 * Focused tests for the ESZ-127 readiness probe (scripts/readiness.mjs), its
 * CLI wrapper, the production-acceptance read-only wiring and the smoke
 * startup wording. Pure Node: the HTTP surfaces are fake, no PHP or MySQL.
 * Run: node --test scripts/readiness.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { probeReadiness, READINESS_COMPONENTS } from "./readiness.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

const JSON_HEADERS = { "content-type": "application/json" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

function healthBody() {
  return {
    status: "ok",
    service: "eszter-api",
    contentSchemaVersion: 1,
    timestamp: "2026-09-04T10:00:00.000Z",
  };
}

function pageBody() {
  return "<!doctype html><html><head><title>Eszter Gyori — Maquillage permanent à Lille</title></head>"
    + '<body><script id="__ESZTER_CONTENT__" type="application/json"></script>'
    + "<main>Baked default copy that must not matter to readiness</main></body></html>";
}

function contentBody() {
  return { revision: 3, content: { sections: [{ id: "intro", title: "Bienvenue" }] } };
}

function servicesBody() {
  return { services: [{ key: "brows", label: "Sourcils", durationMinutes: 30 }] };
}

/** @param {Record<string, any>} routes url → {status?, headers?, body?} | () => same */
async function startServer(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const route = routes[req.url];
    const reply = typeof route === "function" ? route(req) : route;
    if (!reply) {
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found", requestId: "req_zzz" } }));
      return;
    }
    const raw = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
    res.writeHead(reply.status ?? 200, reply.headers ?? JSON_HEADERS);
    res.end(raw);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

const fullStackRoutes = {
  "/api/health": { body: healthBody() },
  "/": { headers: HTML_HEADERS, body: pageBody() },
  "/api/content": { body: contentBody() },
  "/api/booking/services": { body: servicesBody() },
};

test("PASS when all four composed surfaces answer, in frozen order, with no extra requests", async () => {
  const server = await startServer(fullStackRoutes);
  try {
    const verdict = await probeReadiness(server.origin);
    assert.equal(verdict.ready, true);
    assert.deepEqual(verdict.failures, []);
    assert.deepEqual(Object.keys(verdict.components), [...READINESS_COMPONENTS]);
    for (const name of READINESS_COMPONENTS) {
      assert.equal(verdict.components[name].passed, true);
      assert.ok(!("reason" in verdict.components[name]), `${name} must carry no reason on PASS`);
    }
    assert.deepEqual(server.requests, [
      "GET /api/health",
      "GET /",
      "GET /api/content",
      "GET /api/booking/services",
    ]);
  } finally {
    await server.close();
  }
});

test("MySQL unavailable after startup: health/page/content PASS, booking is the only FAIL", async () => {
  const server = await startServer({
    ...fullStackRoutes,
    "/api/booking/services": {
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "unhandled database failure", requestId: "req_zzz" } },
    },
  });
  try {
    const verdict = await probeReadiness(server.origin);
    assert.equal(verdict.ready, false);
    assert.deepEqual(verdict.failures, ["booking"]);
    assert.equal(verdict.components.health.passed, true);
    assert.equal(verdict.components.page.passed, true);
    assert.equal(verdict.components.content.passed, true);
    assert.equal(verdict.components.booking.passed, false);
    assert.equal(
      verdict.components.booking.reason,
      "GET /api/booking/services answered HTTP 500",
    );
  } finally {
    await server.close();
  }
});

test("published content unavailable while the page still serves baked defaults: content is the only FAIL", async () => {
  const server = await startServer({
    ...fullStackRoutes,
    "/api/content": { status: 500, body: { error: { code: "STORAGE_FAILURE", message: "opaque", requestId: "req_zzz" } } },
  });
  try {
    const verdict = await probeReadiness(server.origin);
    assert.equal(verdict.ready, false);
    assert.deepEqual(verdict.failures, ["content"]);
    assert.equal(verdict.components.health.passed, true);
    // The page answer must stay a PASS: baked defaults are a design property.
    assert.equal(verdict.components.page.passed, true);
    assert.equal(verdict.components.booking.passed, true);
    assert.equal(verdict.components.content.passed, false);
    assert.equal(verdict.components.content.reason, "GET /api/content answered HTTP 500");
  } finally {
    await server.close();
  }
});

test("a 200 content reply that is not the published envelope fails the content component", async () => {
  for (const body of [{ content: {} }, { revision: 3 }, {}, "not json"]) {
    const server = await startServer({
      ...fullStackRoutes,
      "/api/content": { body },
    });
    try {
      const verdict = await probeReadiness(server.origin);
      assert.equal(verdict.ready, false);
      assert.deepEqual(verdict.failures, ["content"]);
      assert.equal(
        verdict.components.content.reason,
        "GET /api/content envelope is not the published document",
      );
    } finally {
      await server.close();
    }
  }
});

test("health contract drift fails only the health component", async () => {
  const server = await startServer({
    ...fullStackRoutes,
    "/api/health": { body: { status: "ok" } },
  });
  try {
    const verdict = await probeReadiness(server.origin);
    assert.equal(verdict.ready, false);
    assert.deepEqual(verdict.failures, ["health"]);
    assert.equal(
      verdict.components.health.reason,
      "GET /api/health body is not the frozen health payload",
    );
    // Every surface was still evaluated.
    assert.equal(server.requests.length, 4);
    assert.equal(verdict.components.booking.passed, true);
  } finally {
    await server.close();
  }
});

test("a non-HTML or markerless homepage fails the page component", async () => {
  const variants = [
    { headers: JSON_HEADERS, body: { ok: true } },
    { headers: HTML_HEADERS, body: "<html><body>no bootstrap markers</body></html>" },
  ];
  for (const reply of variants) {
    const server = await startServer({ ...fullStackRoutes, "/": reply });
    try {
      const verdict = await probeReadiness(server.origin);
      assert.equal(verdict.ready, false);
      assert.deepEqual(verdict.failures, ["page"]);
    } finally {
      await server.close();
    }
  }
});

test("booking needs at least one well-formed active service", async () => {
  const variants = [
    { body: { services: [] } },
    { body: {} },
    { body: "oops" },
    { body: { services: [{ key: "brows" }] } },
    { body: { services: [{ key: "brows", label: "Sourcils", durationMinutes: 0 }] } },
  ];
  for (const reply of variants) {
    const server = await startServer({ ...fullStackRoutes, "/api/booking/services": reply });
    try {
      const verdict = await probeReadiness(server.origin);
      assert.equal(verdict.ready, false);
      assert.deepEqual(verdict.failures, ["booking"]);
    } finally {
      await server.close();
    }
  }
});

test("failures never leak response internals (DSN, credentials, paths)", async () => {
  const secretDsn = "mysql:host=internal.db;port=3306;dbname=eszter_prod";
  const secretPassword = "eszter_root_dev_only";
  const secretPath = "/var/www/eszter/data/content/published.json";
  const server = await startServer({
    ...fullStackRoutes,
    "/api/booking/services": {
      status: 503,
      body: { error: { code: "INTERNAL_ERROR", message: `${secretDsn} ${secretPassword} ${secretPath}`, requestId: "req_zzz" } },
    },
  });
  try {
    const verdict = await probeReadiness(server.origin);
    assert.equal(verdict.ready, false);
    const serialized = JSON.stringify(verdict);
    for (const secret of [secretDsn, secretPassword, secretPath]) {
      assert.ok(!serialized.includes(secret), `verdict must not contain ${secret}`);
    }
    for (const name of verdict.failures) {
      const reason = verdict.components[name].reason;
      for (const secret of [secretDsn, secretPassword, secretPath]) {
        assert.ok(!reason.includes(secret), `${name} reason must not contain ${secret}`);
      }
    }
  } finally {
    await server.close();
  }
});

test("verdicts are deterministic across identical runs", async () => {
  const failing = {
    ...fullStackRoutes,
    "/api/booking/services": { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "x", requestId: "req_zzz" } } },
  };
  const first = await startServer(failing);
  const second = await startServer(failing);
  try {
    const verdictA = await probeReadiness(first.origin);
    const verdictB = await probeReadiness(second.origin);
    // The origins differ (two ephemeral ports); everything else must be equal.
    const { origin: originA, ...restA } = verdictA;
    const { origin: originB, ...restB } = verdictB;
    assert.notEqual(originA, originB);
    assert.deepEqual(restB, restA);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a refused connection becomes a deterministic per-component transport failure", async () => {
  // Reserve a loopback port, release it, then probe it: nothing listens there
  // any more, so every request fails with ECONNREFUSED (port 1 is refused by
  // the fetch layer itself with "bad port", which would not exercise this).
  const closedPort = await new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
  const verdict = await probeReadiness(`http://127.0.0.1:${closedPort}/`, { timeoutMs: 2_000 });
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.failures, [...READINESS_COMPONENTS]);
  for (const name of READINESS_COMPONENTS) {
    assert.match(verdict.components[name].reason, /failed \(ECONNREFUSED\)$/);
    assert.ok(!verdict.components[name].reason.includes("127.0.0.1"), "reason must not embed the target address");
  }
});

test("origin validation refuses non-http schemes, credentials, paths, query and fragments", async () => {
  const refused = [
    "ftp://127.0.0.1/",
    "http://user:secret@127.0.0.1/",
    "http://127.0.0.1/some/path",
    "http://127.0.0.1/?a=b",
    "http://127.0.0.1/#frag",
  ];
  for (const origin of refused) {
    await assert.rejects(probeReadiness(origin), Error, origin);
  }
  const server = await startServer(fullStackRoutes);
  try {
    const fromUrlInstance = await probeReadiness(new URL(server.origin));
    assert.equal(fromUrlInstance.ready, true);
    assert.equal(fromUrlInstance.origin, server.origin);
  } finally {
    await server.close();
  }
});

function runCli(args) {
  const cliPath = resolve(scriptsDir, "readiness-cli.mjs");
  // Spawned asynchronously on purpose: the fake HTTP server lives in THIS
  // process, and a blocking spawnSync would starve it and time the CLI out.
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolveRun({ status: 1, stdout, stderr: String(error) }));
    child.once("exit", (status) => resolveRun({ status: status ?? 1, stdout, stderr }));
  });
}

test("CLI reports PASS with exit 0 against a ready origin", async () => {
  const server = await startServer(fullStackRoutes);
  try {
    const result = await runCli([`--origin=${server.origin}`]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.deepEqual(lines, [
      `origin: ${server.origin}`,
      "health: PASS",
      "page: PASS",
      "content: PASS",
      "booking: PASS",
      "readiness: PASS",
    ]);
  } finally {
    await server.close();
  }
});

test("CLI reports the failing component with exit 1 and no internals", async () => {
  const server = await startServer({
    ...fullStackRoutes,
    "/api/booking/services": {
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "mysql:host=secret;password=hunter2", requestId: "req_zzz" } },
    },
  });
  try {
    const result = await runCli([`--origin=${server.origin}`]);
    assert.equal(result.status, 1);
    const lines = result.stdout.trim().split("\n");
    assert.deepEqual(lines, [
      `origin: ${server.origin}`,
      "health: PASS",
      "page: PASS",
      "content: PASS",
      "booking: FAIL — GET /api/booking/services answered HTTP 500",
      "readiness: FAIL",
    ]);
    assert.ok(!result.stdout.includes("hunter2"));
  } finally {
    await server.close();
  }
});

test("CLI usage: missing or invalid origin exits 2, --help exits 0", async () => {
  const missing = await runCli([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--origin=/);

  const invalid = await runCli(["--origin=http://user:pass@127.0.0.1/"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /credentials/);

  const help = await runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /readiness-cli/);
});

test("production acceptance read-only mode reuses the probe instead of duplicating checks", () => {
  const acceptance = readFileSync(resolve(scriptsDir, "production-acceptance.mjs"), "utf8");
  assert.match(
    acceptance,
    /import \{ probeReadiness, READINESS_COMPONENTS \} from "\.\/readiness\.mjs";/,
  );
  const readOnly = acceptance.slice(
    acceptance.indexOf("async function readOnlyChecks"),
    acceptance.indexOf("async function fullAcceptance"),
  );
  assert.match(readOnly, /probeReadiness\(target\.origin\)/);
  assert.doesNotMatch(readOnly, /request\("\/(?:api\/health|api\/content)"/);
  assert.match(readOnly, /READINESS \$\{name\}/);
  assert.match(acceptance, /Readiness PASS: liveness, public page, published content and booking services all answered/);
});

test("startup wording calls health waits 'live', never 'ready'", () => {
  const local = readFileSync(resolve(scriptsDir, "smoke-local-php.mjs"), "utf8");
  const fullStack = readFileSync(resolve(scriptsDir, "smoke-full-stack.mjs"), "utf8");
  for (const [file, text] of [["smoke-local-php.mjs", local], ["smoke-full-stack.mjs", fullStack]]) {
    assert.ok(!text.includes("become ready"), `${file} must not call the health wait 'ready'`);
    assert.match(text, /become live/, `${file} must call the health wait 'live'`);
  }
  assert.match(local, /Readiness \(published envelope, booking\/MySQL\) is not part of this smoke/);
  assert.match(fullStack, /async function waitUntilLive/);
});

test("the CLI module is referenced from the root package.json script", () => {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["readiness:probe"], "node scripts/readiness-cli.mjs");
});
