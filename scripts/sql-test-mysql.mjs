#!/usr/bin/env node
/**
 * ESZ-112 — the repo-owned disposable MySQL used by the SQL gates.
 *
 * The SQL gates (`sql:migrations`, `sql:integration`, `sql:rate-limits`,
 * `sql:backup-restore`, `sql:notifications`) prove schema and repository
 * behaviour on the real engine, so they need a MySQL server. They must never
 * use the development instance behind `compose.dev.yml` (`eszter_dev`, the
 * `eszter-development` compose project and its persistent volume) or any
 * database a human created: these suites drop and truncate tables, and the
 * only safe target is a server that exists for the run and dies with it.
 *
 * This module provisions exactly that: one MySQL 8.4 container on a
 * collision-free host port, a database whose name ends in `_test` (the naming
 * rule `Eszter\Tests\Sql\TestDatabase` enforces), test-only credentials, and
 * the two server-side facts the suites need — `log_bin_trust_function_creators`
 * and the grant that lets the derived `…_restore_test` database be created.
 *
 * The module is deliberately synchronous (`spawnSync`): `scripts/validate.mjs`
 * and `scripts/sql-gates.mjs` run their gates synchronously and both need the
 * environment exported before the first SQL child starts. It is also
 * deliberately free of any gate logic — provisioning and disposal only — so the
 * Docker orchestration stays out of `validate.mjs` and out of any one script.
 *
 * Caller contract:
 *
 *   - `ESZTER_TEST_DB_DSN` set by the caller wins. When it is present nothing
 *     here provisions anything: the caller owns the database and the cleanup.
 *   - Absent that variable, `provisionSqlTestMySql()` creates an isolated
 *     instance. The returned handle carries the `ESZTER_TEST_*` environment to
 *     export to child processes and a `dispose()` that removes the container
 *     and its volume. Dispose must run on success, on failure and on
 *     interruption — callers use `try`/`finally` and a signal handler.
 *   - Provisioning cleans up its own partial state before rethrowing, so a
 *     failed provision leaves nothing behind either.
 *
 * Nothing here ever touches `eszter_dev`, the `compose.dev.yml` volume, or a
 * named user database: the container is created from the image alone, gets a
 * random identity and port, and its whole state lives in the container's own
 * anonymous volume, which disposal removes.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** The MySQL image the gates are proved against. */
export const MYSQL_IMAGE = "mysql:8.4";

/**
 * Every disposable resource is named from this prefix plus a random suffix, so
 * a run never collides with a live or leftover instance of another run.
 */
export const IDENTITY_PREFIX = "eszter-sql-test";

/** Test-only constant account; credentials are generated, never production secrets. */
export const TEST_USERNAME = "eszter_sql_test";

/**
 * Databases this workflow creates start with the identity prefix; the primary
 * one is `<identity>_test` and `sql:backup-restore` derives
 * `<identity>_restore_test`. One grant pattern covers both. The server is
 * disposable and only this run's databases ever match the pattern.
 */
export const GRANT_DATABASE_PATTERN = `${IDENTITY_PREFIX}-%`;

/** How long a freshly started server may take to accept connections. */
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 500;

let dockerAvailability = null;

/** @param {number} bytes */
export function randomHex(bytes = 4) {
  return randomBytes(bytes).toString("hex");
}

/** One run's identity: `eszter-sql-test-<8 hex chars>`. */
export function sqlTestIdentity() {
  return `${IDENTITY_PREFIX}-${randomHex(4)}`;
}

/** The primary database name: always ends in `_test`, as TestDatabase requires. */
export function sqlTestDatabaseName(identity) {
  return `${identity}_test`;
}

/**
 * Whether a Docker engine is reachable. Memoised: the answer cannot change
 * usefully during one run, and `validate --list` calls this once per gate.
 */
export function dockerEngineAvailable() {
  if (dockerAvailability === null) {
    dockerAvailability = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
      stdio: "ignore",
    }).status === 0;
  }
  return dockerAvailability;
}

/**
 * Builds the environment the SQL suites read, from a provisioned instance.
 *
 * @param {object} instance
 * @returns {Record<string, string>}
 */
export function sqlTestEnvironment(instance) {
  return {
    ESZTER_TEST_DB_DSN: `mysql:host=127.0.0.1;port=${instance.port};dbname=${instance.databaseName};charset=utf8mb4`,
    ESZTER_TEST_DB_USERNAME: TEST_USERNAME,
    ESZTER_TEST_DB_PASSWORD: instance.password,
  };
}

function docker(args, options = {}) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
}

function describeFailure(what, result) {
  const stderr = `${result.stderr ?? ""}`.trimEnd();
  return `${what} failed (exit ${result.status ?? "?"})${stderr ? `: ${stderr.split("\n").slice(-3).join(" ")}` : ""}`;
}

function containerLogs(identity) {
  const logs = docker(["logs", "--tail", "30", identity]);
  const text = `${logs.stdout ?? ""}${logs.stderr ?? ""}`.trimEnd();
  return text ? `\ncontainer logs:\n${text.split("\n").map((line) => `  ${line}`).join("\n")}` : "";
}

/** Waits until `mysqladmin ping` answers inside the container. */
function waitForMysqlHealth(identity) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // The password is read from the container's own environment (set at
    // `docker run` time), so it never appears in a host-side command line.
    const ping = docker([
      "exec", identity, "sh", "-lc",
      'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent',
    ], { stdio: "ignore" });

    if (ping.status === 0) return;

    spawnSync("sleep", [String(HEALTH_POLL_MS / 1000)], { stdio: "ignore" });
  }

  throw new Error(
    `the disposable MySQL container did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`
    + containerLogs(identity),
  );
}

/** Resolves the published host port (`127.0.0.1:<port>`) via `docker port`. */
function resolvePublishedPort(identity) {
  const result = docker(["port", identity, "3306/tcp"]);

  if (result.status !== 0) {
    throw new Error(describeFailure(`resolving the published port of ${identity}`, result));
  }

  const match = /:(\d+)\s*$/.exec(`${result.stdout ?? ""}`.trim());

  if (!match) {
    throw new Error(`could not resolve the published port of ${identity} (docker port said: ${result.stdout?.trim() ?? ""})`);
  }

  return match[1];
}

/**
 * Provisions one isolated MySQL 8.4 test instance.
 *
 * @returns {{
 *   identity: string, containerName: string, image: string,
 *   databaseName: string, port: string, password: string,
 *   env: Record<string, string>, dispose: () => void,
 * }}
 * @throws {Error} when Docker is unavailable or any step fails; partial state
 *   is disposed before the throw, so a failed provision leaves nothing behind.
 */
export function provisionSqlTestMySql() {
  // Overridable so an environment with a registry mirror can name its own
  // copy of the image. It is a location, never a behaviour switch.
  const image = process.env.ESZTER_TEST_MYSQL_IMAGE || MYSQL_IMAGE;

  if (!dockerEngineAvailable()) {
    throw new Error(
      "no Docker engine is reachable and no ESZTER_TEST_DB_DSN is set. "
      + "Either set ESZTER_TEST_DB_DSN (plus ESZTER_TEST_DB_USERNAME and "
      + "ESZTER_TEST_DB_PASSWORD) to a disposable MySQL database whose name ends "
      + "in `_test`, or start Docker so the disposable test instance can be provisioned.",
    );
  }

  // base64url keeps every generated secret shell-safe and DSN-free: it never
  // leaves the environment it was generated for.
  const identity = sqlTestIdentity();
  const rootPassword = randomBytes(18).toString("base64url");
  const password = randomBytes(18).toString("base64url");
  const databaseName = sqlTestDatabaseName(identity);
  let containerStarted = false;

  try {
    const created = docker([
      "run", "--detach", "--name", identity,
      // Random free port on the loopback only: collision-safe, never exposed.
      "--publish", "127.0.0.1::3306",
      "--env", `MYSQL_ROOT_PASSWORD=${rootPassword}`,
      "--env", `MYSQL_DATABASE=${databaseName}`,
      "--env", `MYSQL_USER=${TEST_USERNAME}`,
      "--env", `MYSQL_PASSWORD=${password}`,
      image,
    ]);

    if (created.status !== 0) {
      throw new Error(describeFailure(`starting the disposable MySQL container (image ${image})`, created));
    }
    containerStarted = true;

    waitForMysqlHealth(identity);

    const port = resolvePublishedPort(identity);

    // The official image entrypoint created the account and the primary
    // database; the suites additionally need the derived `…_restore_test`
    // database to be creatable, and the fault-injection/migration triggers
    // need function-creation trust. The password again comes from the
    // container environment, never from a host-side command line.
    const setup = docker([
      "exec", identity, "sh", "-lc",
      `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SET GLOBAL log_bin_trust_function_creators = 1;`
      + ` GRANT ALL PRIVILEGES ON \\\`${GRANT_DATABASE_PATTERN}\\\`.* TO '${TEST_USERNAME}'@'%';"`,
    ]);

    if (setup.status !== 0) {
      throw new Error(describeFailure("configuring the disposable MySQL instance", setup));
    }

    const env = sqlTestEnvironment({ identity, databaseName, port, password });

    return {
      identity,
      containerName: identity,
      image,
      databaseName,
      port,
      password,
      env,
      dispose: () => disposeSqlTestMySql(identity),
    };
  } catch (error) {
    if (containerStarted) {
      const message = error instanceof Error ? error.message : String(error);
      disposeSqlTestMySql(identity);
      throw new Error(`${message}${containerLogs(identity)}`);
    }
    throw error;
  }
}

/**
 * Removes a provisioned instance: container first, then its anonymous volume.
 * Tolerant and idempotent — a container that is already gone is not an error,
 * so cleanup paths can run unconditionally.
 *
 * @param {object|string} handleOrIdentity
 * @returns {{ ok: boolean }}
 */
export function disposeSqlTestMySql(handleOrIdentity) {
  const identity = typeof handleOrIdentity === "string"
    ? handleOrIdentity
    : handleOrIdentity?.identity ?? handleOrIdentity?.containerName;

  if (!identity) return { ok: false };

  const removed = docker(["rm", "--force", "--volumes", identity]);
  const alreadyGone = /No such container/i.test(`${removed.stderr ?? ""}`);

  return { ok: removed.status === 0 || alreadyGone };
}
