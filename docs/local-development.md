# Local development — full-stack contract

The canonical local workflow represents the V1 product, including MySQL-backed booking and admin authentication. A public page returning `200` while `/api/booking/*` is absent is not a valid development runtime.

## Prerequisites

- PHP and Composer compatible with `php/composer.json`;
- Node/npm compatible with the frontend lockfile;
- Docker with Compose v2.

Production remains Docker-free. `compose.dev.yml` exists only to make the developer/test dependency reproducible.

## First boot and ordinary boot

```bash
npm run dev:bootstrap
npm run php:serve
```

`npm run php:serve` also runs the development bootstrap automatically when it uses the project-owned `php/config/config.development.php`. Pass `--skip-bootstrap` only from a test/tool that deliberately prepared the database already.

The bootstrap is repeat-safe. It:

1. installs missing Composer/contracts/frontend dependencies;
2. starts the project-owned MySQL 8.4 container on loopback port `3307` by default;
3. applies the real forward-only migrations;
4. provisions the four canonical bookable-service keys;
5. replaces development weekly availability with Monday-Saturday, 09:00-17:00;
6. provisions the development admin account.

The generated admin credential is stored only in the ignored file:

```text
php/var/development/development-admin.json
```

The file is created with mode `0600` inside a `0700` directory. The password is not printed by the bootstrap and is never accepted as a process argument.

The development account is:

```text
admin@eszter.test
```

## Full-stack smoke

```bash
npm run php:smoke:full-stack
```

This is intentionally stronger than `npm run php:smoke`.

- `php:smoke` remains the lightweight routing/export smoke and starts the PHP launcher with `--skip-bootstrap`.
- `php:smoke:full-stack` (canonical validate gate `php:smoke:full-stack` since ESZ-124) provisions one **disposable** MySQL 8.4 container through the shared ESZ-112 primitive (`scripts/sql-test-mysql.mjs`) — never the `eszter_dev` deployment or its volume — applies the real migrations and deterministic fixtures to it, keeps every byte of runtime state (content, logs, credentials, config) under one scratch root, builds the real export, and starts an isolated PHP server on a collision-safe loopback port, then proves the composed product:
  - public page;
  - reservation page;
  - a generated frontend asset;
  - exported public and JSON API `404` contracts;
  - `GET /api/booking/services`;
  - real availability from MySQL fixtures;
  - atomic booking creation;
  - anonymous CSRF session;
  - admin login and rotated CSRF token;
  - visibility of the created booking in the authenticated admin API (ESZ-145 envelope);
  - an admin cancel carrying the booking's optimistic-concurrency token;
  - server-side logout enforcement;
  - confirmed PHP server shutdown.

A failure in any step is a failed smoke, not a `NOT RUN` or a page-level success. The smoke's exit code is the gate outcome, so no skipped PHPUnit or missing infrastructure can read as PASS. Because the whole backing state is disposable, the booking, its sessions, its notification jobs and its logs leave no persistent residue: the container and its volume are removed and the scratch root deleted on PASS, on assertion failure and on interruption.

## Resetting local data

```bash
npm run dev:reset
```

This removes the development MySQL volume and rebuilds the development state through migrations and explicit fixtures. It is intentionally destructive to **development data only**.

To stop MySQL without deleting its volume:

```bash
npm run dev:down
```

## Optional local overrides

The development-only defaults can be overridden without changing tracked files:

- `ESZTER_DEV_DB_NAME`
- `ESZTER_DEV_DB_USERNAME`
- `ESZTER_DEV_DB_PASSWORD`
- `ESZTER_DEV_DB_ROOT_PASSWORD`
- `ESZTER_DEV_DB_PORT`

These names are development plumbing only. Production still reads its private file-based `php/config/config.php` and must not depend on the local defaults.
