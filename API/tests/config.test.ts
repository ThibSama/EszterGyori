import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { loadConfig } from "../src/config";

test("default configuration is valid", () => {
  const config = loadConfig({});

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4000);
  assert.equal(config.logLevel, "info");
  assert.equal(config.contentDataDir, resolve("data"));
});

test("explicit valid configuration is parsed", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "0.0.0.0",
    PORT: "5050",
    LOG_LEVEL: "debug",
    CONTENT_DATA_DIR: "custom-data",
  });

  assert.equal(config.nodeEnv, "test");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 5050);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.contentDataDir, resolve("custom-data"));
});

test("absolute CONTENT_DATA_DIR is preserved", () => {
  const absolutePath = resolve("absolute-content-data");
  const config = loadConfig({ CONTENT_DATA_DIR: absolutePath });

  assert.equal(config.contentDataDir, absolutePath);
});

test("empty CONTENT_DATA_DIR is rejected", () => {
  assert.throws(
    () => loadConfig({ CONTENT_DATA_DIR: "   " }),
    (error: unknown) => error instanceof ZodError,
  );
});

test("invalid PORT is rejected", () => {
  assert.throws(
    () => loadConfig({ PORT: "invalid" }),
    (error: unknown) => error instanceof ZodError,
  );
});

test("out-of-range PORT is rejected", () => {
  assert.throws(
    () => loadConfig({ PORT: "70000" }),
    (error: unknown) => error instanceof ZodError,
  );
});

test("invalid NODE_ENV is rejected", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "staging" }),
    (error: unknown) => error instanceof ZodError,
  );
});

test("invalid LOG_LEVEL is rejected", () => {
  assert.throws(
    () => loadConfig({ LOG_LEVEL: "trace" }),
    (error: unknown) => error instanceof ZodError,
  );
});
