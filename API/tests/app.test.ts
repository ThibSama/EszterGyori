import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { createApp, SERVICE_NAME } from "../src/app";
import { SITE_CONTENT_SCHEMA_VERSION } from "@eszter/contracts";
import {
  CONTENT_ENVELOPE_SCHEMA_VERSION,
  defaultSiteAppearance,
  type PublishedContentEnvelopeV1,
} from "@eszter/contracts";
import { defaultSiteContent } from "@eszter/contracts";
import { StorageError } from "../src/storage";

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

function createPublishedEnvelope(
  overrides: Partial<PublishedContentEnvelopeV1> = {},
): PublishedContentEnvelopeV1 {
  return {
    schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
    revision: 3,
    publishedAt: "2026-06-13T12:00:00.000Z",
    content: defaultSiteContent,
    ...overrides,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function withTestServer<T>(
  run: (baseUrl: string) => Promise<T>,
  options: { published?: unknown; failWithStorageError?: boolean } = {},
) {
  const published = options.published ?? createPublishedEnvelope();
  const app = createApp({
    publishedContentReader: {
      async readPublished() {
        if (options.failWithStorageError) {
          throw new StorageError(
            "STORAGE_READ_FAILED",
            "Synthetic storage failure.",
            { fileRole: "published" },
          );
        }
        return published as PublishedContentEnvelopeV1;
      },
    },
  });
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

test("GET /api/content returns the validated published envelope", async () => {
  const envelope = createPublishedEnvelope({ revision: 12 });
  await withTestServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/content`, {
        headers: { "X-Request-Id": "req_public-content" },
      });
      const body = await readJson<PublishedContentEnvelopeV1>(response);

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(response.headers.get("x-request-id"), "req_public-content");
      assert.equal(response.headers.get("etag"), '"published-12"');
      assert.equal(
        response.headers.get("cache-control"),
        "public, max-age=0, must-revalidate",
      );
      assert.deepEqual(body, envelope);
      assert.equal(body.schemaVersion, CONTENT_ENVELOPE_SCHEMA_VERSION);
      assert.equal(body.revision, 12);
      assert.equal(body.publishedAt, envelope.publishedAt);
      assert.deepEqual(body.content, defaultSiteContent);
      assert.equal((body as { updatedAt?: string }).updatedAt, undefined);
    },
    { published: envelope },
  );
});

test("GET /api/content normalizes legacy appearance without changing ETag format", async () => {
  const { appearance: _appearance, ...legacyContent } = defaultSiteContent;
  const envelope = {
    schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
    revision: 15,
    publishedAt: "2026-06-13T12:00:00.000Z",
    content: legacyContent,
  };

  await withTestServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/content`);
      const body = await readJson<PublishedContentEnvelopeV1>(response);

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("etag"), '"published-15"');
      assert.deepEqual(body.content.appearance, defaultSiteAppearance);
    },
    { published: envelope },
  );
});

test("GET /api/content rejects malformed reader responses safely", async () => {
  await withTestServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/content`);
      const body = await readJson<ErrorResponse>(response);

      assert.equal(response.status, 500);
      assert.equal(body.error.code, "STORAGE_FAILURE");
      assert.equal(
        body.error.message,
        "Le contenu publié est momentanément indisponible.",
      );
      assert.equal(body.error.requestId, response.headers.get("x-request-id"));
      const serialized = JSON.stringify(body);
      assert.doesNotMatch(serialized, /E:\\|content|SiteContent|Zod/i);
    },
    { published: { schemaVersion: 1, revision: "invalid" } },
  );
});

test("GET /api/content maps typed storage failures to safe 500 responses", async () => {
  await withTestServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/content`);
      const body = await readJson<ErrorResponse>(response);

      assert.equal(response.status, 500);
      assert.equal(body.error.code, "STORAGE_FAILURE");
      assert.equal(
        body.error.message,
        "Le contenu publié est momentanément indisponible.",
      );
      assert.equal(body.error.requestId, response.headers.get("x-request-id"));
      assert.doesNotMatch(JSON.stringify(body), /E:\\|draft|published\.json/i);
    },
    { failWithStorageError: true },
  );
});

test("GET /api/content supports If-None-Match", async () => {
  const envelope = createPublishedEnvelope({ revision: 8 });
  await withTestServer(
    async (baseUrl) => {
      const matching = await fetch(`${baseUrl}/api/content`, {
        headers: { "If-None-Match": '"published-8"' },
      });
      assert.equal(matching.status, 304);
      assert.equal(matching.headers.get("etag"), '"published-8"');
      assert.equal(
        matching.headers.get("cache-control"),
        "public, max-age=0, must-revalidate",
      );
      assert.equal(await matching.text(), "");

      const stale = await fetch(`${baseUrl}/api/content`, {
        headers: { "If-None-Match": '"published-7"' },
      });
      assert.equal(stale.status, 200);

      const list = await fetch(`${baseUrl}/api/content`, {
        headers: { "If-None-Match": '"other", "published-8"' },
      });
      assert.equal(list.status, 304);

      const wildcard = await fetch(`${baseUrl}/api/content`, {
        headers: { "If-None-Match": "*" },
      });
      assert.equal(wildcard.status, 304);

      const malformed = await fetch(`${baseUrl}/api/content`, {
        headers: { "If-None-Match": "not an etag" },
      });
      assert.equal(malformed.status, 200);
    },
    { published: envelope },
  );
});

test("unsupported public content methods and absent admin routes keep expected behavior", async () => {
  await withTestServer(async (baseUrl) => {
    const method = await fetch(`${baseUrl}/api/content`, { method: "POST" });
    const methodBody = await readJson<ErrorResponse>(method);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET");
    assert.equal(methodBody.error.code, "METHOD_NOT_ALLOWED");

    for (const route of [
      "/api/admin/content/draft",
      "/api/admin/content/publish",
      "/api/admin/content/reset",
      "/api/admin/media",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/session",
    ]) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 404, route);
    }
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
  const app = createApp({
    publishedContentReader: {
      async readPublished() {
        return createPublishedEnvelope();
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.ok((address as AddressInfo).port > 0);
  server.close();
  await once(server, "close");
});
