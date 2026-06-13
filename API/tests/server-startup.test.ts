import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { defaultSiteContent } from "@eszter/contracts";
import type { PublishedContentEnvelopeV1 } from "@eszter/contracts";
import { createContentStorage } from "../src/storage";
import { startServer } from "../src/server";
import type { ServerConfig } from "../src/config";
import { StorageError } from "../src/storage/storage-errors";

async function withTemporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "eszter-server-startup-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function testConfig(directory: string): ServerConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    logLevel: "info",
    contentDataDir: directory,
  };
}

test("server initializes storage before listening and health remains available", async () => {
  await withTemporaryDirectory(async (directory) => {
    const server = await startServer(testConfig(directory));
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = (address as AddressInfo).port;

    const storage = createContentStorage(directory);
    assert.equal((await storage.readDraft()).revision, 0);
    assert.equal((await storage.readPublished()).revision, 0);

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);

    const contentResponse = await fetch(`http://127.0.0.1:${port}/api/content`);
    assert.equal(contentResponse.status, 200);

    server.close();
    await once(server, "close");
  });
});

test("public content endpoint returns persisted published content after restart", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);
    const published = await storage.readPublished();
    const updatedPublished: PublishedContentEnvelopeV1 = {
      ...published,
      revision: 44,
      publishedAt: "2026-06-13T13:00:00.000Z",
      content: {
        ...published.content,
        hero: {
          ...published.content.hero,
          badgeLabel: "Persisted public content",
        },
      },
    };
    await storage.writePublished(updatedPublished);

    const restartedStorage = createContentStorage(directory);
    const server = await startServer(testConfig(directory));
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const response = await fetch(
      `http://127.0.0.1:${(address as AddressInfo).port}/api/content`,
    );
    const body = (await response.json()) as PublishedContentEnvelopeV1;

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), '"published-44"');
    assert.deepEqual(body, await restartedStorage.readPublished());
    assert.equal(body.content.hero.badgeLabel, "Persisted public content");

    server.close();
    await once(server, "close");
  });
});

test("invalid storage prevents the server from opening a port", async () => {
  await withTemporaryDirectory(async (directory) => {
    await createContentStorage(directory).initialize(defaultSiteContent);
    await writeFile(join(directory, "draft.json"), "{invalid-json", "utf8");

    await assert.rejects(
      () => startServer(testConfig(directory)),
      (error: unknown) =>
        error instanceof StorageError && error.code === "STORAGE_INVALID_JSON",
    );
  });
});

test("graceful shutdown still handles SIGTERM", async () => {
  await withTemporaryDirectory(async (directory) => {
    const script = `
      import { once } from "node:events";
      import { startServer } from "./src/server.ts";
      const server = await startServer({
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 0,
        logLevel: "info",
        contentDataDir: ${JSON.stringify(directory)}
      });
      await once(server, "listening");
      process.emit("SIGTERM", "SIGTERM");
    `;

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
      cwd: process.cwd(),
      env: { ...process.env, CONTENT_DATA_DIR: directory },
      stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /Received SIGTERM/);
    assert.match(stdout, /eszter-api closed/);
  });
});
