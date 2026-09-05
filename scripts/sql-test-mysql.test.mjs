#!/usr/bin/env node
/**
 * ESZ-112 — tests for the disposable-MySQL harness (`scripts/sql-test-mysql.mjs`).
 *
 * The pure tests (identity, naming, environment shape) run everywhere. The
 * provisioning tests need a real Docker engine and the `mysql:8.4` image and
 * skip honestly when either is missing — the same stance the SQL suites take
 * without a database. Every provisioning test disposes its instance in a
 * `finally`, and the disposal assertions are what prove the cleanup contract:
 * no container, no volume, no database (the databases live in the removed
 * volume), no occupied port.
 *
 * Run: `node --test scripts/sql-test-mysql.test.mjs`
 */

import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import {
  IDENTITY_PREFIX,
  disposeSqlTestMySql,
  dockerEngineAvailable,
  provisionSqlTestMySql,
  sqlTestDatabaseName,
  sqlTestEnvironment,
  sqlTestIdentity,
} from "./sql-test-mysql.mjs";

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", stdio: "pipe", ...options });
}

function containerNames() {
  const result = docker(["ps", "-a", "--filter", `name=${IDENTITY_PREFIX}`, "--format", "{{.Names}}"]);
  return `${result.stdout ?? ""}`.split("\n").map((line) => line.trim()).filter(Boolean);
}

function containerVolumeNames(identity) {
  const result = docker([
    "inspect", "--format", "{{range .Mounts}}{{if .Name}}{{.Name}} {{end}}{{end}}", identity,
  ]);
  return `${result.stdout ?? ""}`.trim().split(/\s+/).filter(Boolean);
}

function connectable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port), timeout: 1000 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

describe("sql-test-mysql identity and environment", () => {
  test("identities are unique and collision-safe by construction", () => {
    const seen = new Set();
    for (let index = 0; index < 20; index += 1) {
      const identity = sqlTestIdentity();
      assert.match(identity, new RegExp(`^${IDENTITY_PREFIX}-[0-9a-f]{8}$`));
      assert.equal(seen.has(identity), false);
      seen.add(identity);
    }
  });

  test("the database name ends in `_test`, as TestDatabase demands", () => {
    const identity = sqlTestIdentity();
    const name = sqlTestDatabaseName(identity);
    assert.ok(name.startsWith(`${identity}_`));
    assert.ok(name.endsWith("_test"), name);
  });

  test("the exported environment names a disposable MySQL `_test` database", () => {
    const instance = {
      identity: sqlTestIdentity(),
      databaseName: sqlTestDatabaseName(sqlTestIdentity()),
      port: "54321",
      password: "s3cret-test-only",
    };
    const env = sqlTestEnvironment(instance);

    assert.equal(env.ESZTER_TEST_DB_USERNAME, "eszter_sql_test");
    assert.equal(env.ESZTER_TEST_DB_PASSWORD, instance.password);
    assert.match(env.ESZTER_TEST_DB_DSN, /^mysql:host=127\.0\.0\.1;port=54321;dbname=.*_test;charset=utf8mb4$/);
    assert.equal(env.ESZTER_TEST_DB_DSN.includes("eszter_dev"), false);
    assert.equal(env.ESZTER_TEST_DB_DSN.includes(instance.password), false);
  });
});

describe("sql-test-mysql provisioning (needs a Docker engine)", { skip: !dockerEngineAvailable() && "no Docker engine is reachable" }, () => {
  test("provisions an isolated instance, serves the suites, and cleans up completely", async () => {
    const before = new Set(containerNames());

    const handle = provisionSqlTestMySql();
    try {
      assert.ok(handle.identity.startsWith(`${IDENTITY_PREFIX}-`));
      assert.equal(before.has(handle.identity), false, "the identity must be fresh");
      assert.equal(handle.databaseName, `${handle.identity}_test`);
      assert.ok(handle.databaseName.endsWith("_test"));

      // The container is up and the published host port answers.
      const inspect = docker(["inspect", "--format", "{{.State.Running}}", handle.identity]);
      assert.equal(`${inspect.stdout ?? ""}`.trim(), "true");
      assert.equal(await connectable(handle.port), true, `port ${handle.port} must listen`);

      // The primary database exists and the app account reaches it over TCP.
      // Its password is the container's own MYSQL_PASSWORD environment, set at
      // `docker run` time — never a host-side command line.
      const asApp = docker([
        "exec", handle.identity, "sh", "-lc",
        'mysql -h127.0.0.1 -P3306 -ueszter_sql_test -p"$MYSQL_PASSWORD" -N -e "SELECT 1"',
      ]);
      assert.equal(asApp.status, 0, `app user must connect: ${asApp.stderr}`);

      // The derived `…_restore_test` database is creatable by the app account
      // (sql:backup-restore creates it) and the server trusts function creators
      // (migration/fault-injection triggers), both server-side facts ESZ-112 sets.
      const derived = `${handle.databaseName.slice(0, -"_test".length)}_restore_test`;
      const roundTrip = docker([
        "exec", handle.identity, "sh", "-lc",
        'mysql -h127.0.0.1 -P3306 -ueszter_sql_test -p"$MYSQL_PASSWORD" '
        + `-e "CREATE DATABASE IF NOT EXISTS \\\`${derived}\\\`; DROP DATABASE \\\`${derived}\\\`;"`,
      ]);
      assert.equal(roundTrip.status, 0, `restore target must be creatable: ${roundTrip.stderr}`);

      const trust = docker([
        "exec", handle.identity, "sh", "-lc",
        'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SHOW VARIABLES LIKE \'log_bin_trust_function_creators\'"',
      ]);
      assert.equal(trust.status, 0);
      assert.match(`${trust.stdout ?? ""}`, /ON/i);
    } finally {
      const volumeNames = containerVolumeNames(handle.identity);
      const result = disposeSqlTestMySql(handle);

      assert.equal(result.ok, true);
      assert.equal(containerNames().includes(handle.identity), false, "container must be gone");
      assert.equal(await connectable(handle.port), false, "the published port must be free");

      for (const volume of volumeNames) {
        const inspect = docker(["volume", "inspect", volume]);
        assert.notEqual(inspect.status, 0, `volume ${volume} must be removed`);
      }
    }
  });

  test("cleans up after an intentionally failing child command", async () => {
    const handle = provisionSqlTestMySql();
    try {
      const failing = spawnSync("sh", ["-c", 'echo "child failed" >&2; exit 5'], {
        env: { ...process.env, ...handle.env },
        encoding: "utf8",
      });
      assert.equal(failing.status, 5, "the failing child must fail");

      // The instance was still serving when the child failed…
      assert.equal(docker(["inspect", "--format", "{{.State.Running}}", handle.identity]).status, 0);
    } finally {
      // …and disposal still removes everything.
      const volumeNames = containerVolumeNames(handle.identity);
      assert.equal(disposeSqlTestMySql(handle).ok, true);
      assert.equal(containerNames().includes(handle.identity), false);
      assert.equal(await connectable(handle.port), false);
      for (const volume of volumeNames) {
        assert.notEqual(docker(["volume", "inspect", volume]).status, 0, `volume ${volume} must be removed`);
      }
    }
  });

  test("disposal is idempotent and tolerant of an already-gone container", () => {
    assert.equal(disposeSqlTestMySql({ identity: `${IDENTITY_PREFIX}-00000000` }).ok, true);
    const handle = provisionSqlTestMySql();
    disposeSqlTestMySql(handle);
    assert.equal(disposeSqlTestMySql(handle).ok, true, "a second dispose must be harmless");
  });
});
