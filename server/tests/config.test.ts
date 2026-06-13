import test from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { loadConfig } from "../src/config";

test("default configuration is valid", () => {
  const config = loadConfig({});

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4000);
  assert.equal(config.logLevel, "info");
});

test("explicit valid configuration is parsed", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "0.0.0.0",
    PORT: "5050",
    LOG_LEVEL: "debug",
  });

  assert.equal(config.nodeEnv, "test");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 5050);
  assert.equal(config.logLevel, "debug");
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
