import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { createApp, SERVICE_NAME } from "../src/app";
import { SITE_CONTENT_SCHEMA_VERSION } from "../../contracts/site-content";

interface HealthResponse {
  status: string;
  service: string;
  contentSchemaVersion: number;
  timestamp: string;
  uptimeSeconds: number;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function withTestServer<T>(run: (baseUrl: string) => Promise<T>) {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address as AddressInfo;

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("GET /api/health returns the expected health payload", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await readJson<HealthResponse>(response);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(body.status, "ok");
    assert.equal(body.service, SERVICE_NAME);
    assert.equal(body.contentSchemaVersion, SITE_CONTENT_SCHEMA_VERSION);
    assert.equal(new Date(body.timestamp).toISOString(), body.timestamp);
    assert.equal(typeof body.uptimeSeconds, "number");
    assert.ok(Number.isFinite(body.uptimeSeconds));
    assert.ok(body.uptimeSeconds >= 0);
    assert.match(response.headers.get("x-request-id") ?? "", /^req_/);
  });
});

test("request id middleware preserves a safe inbound request id", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { "X-Request-Id": "req_test-123" },
    });

    assert.equal(response.headers.get("x-request-id"), "req_test-123");
  });
});

test("request id middleware replaces an unsafe inbound request id", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { "X-Request-Id": "../unsafe request id" },
    });

    const requestId = response.headers.get("x-request-id") ?? "";
    assert.notEqual(requestId, "../unsafe request id");
    assert.match(requestId, /^req_/);
  });
});

test("unknown routes return structured JSON 404 responses", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/unknown`);
    const body = await readJson<ErrorResponse>(response);

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(body.error.requestId, response.headers.get("x-request-id"));
  });
});

test("unsupported health methods return structured JSON 405 responses", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, { method: "POST" });
    const body = await readJson<ErrorResponse>(response);

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
    assert.equal(body.error.requestId, response.headers.get("x-request-id"));
  });
});

test("invalid JSON returns a structured JSON 400 response", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    });
    const body = await readJson<ErrorResponse>(response);

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_JSON");
    assert.equal(body.error.requestId, response.headers.get("x-request-id"));
  });
});

test("an app server can listen on an ephemeral port and close cleanly", async () => {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.ok((address as AddressInfo).port > 0);
  server.close();
  await once(server, "close");
});
