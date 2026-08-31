<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Config\DatabaseSettings;
use Eszter\Database\Database;
use Eszter\Database\Migrator;
use Eszter\Support\Clock;
use Eszter\Support\SystemClock;

/**
 * The disposable database the `sql:migrations` and `sql:integration` gates run
 * against.
 *
 * ## Configuration, and why the gates are NOT RUN without it
 *
 * The connection comes from the environment, not from a committed file:
 *
 *   ESZTER_TEST_DB_DSN=mysql:host=127.0.0.1;port=3306;dbname=eszter_test;charset=utf8mb4
 *   ESZTER_TEST_DB_USERNAME=eszter
 *   ESZTER_TEST_DB_PASSWORD=…
 *
 * When they are absent, `scripts/validate.mjs` reports both gates as NOT RUN with
 * that as the reason. `docs/v1-quality-gates.md` is explicit that NOT RUN is never
 * a pass — the point of declaring them is that the gap stays visible rather than
 * being silently absent.
 *
 * ## MySQL, not SQLite
 *
 * The target host runs MySQL and these gates exist to prove the schema works
 * *there*. SQLite would be far easier to arrange and would prove almost nothing
 * that matters: no `utf8mb4`, different collation semantics, no
 * `ON DUPLICATE KEY UPDATE`, no `GET_LOCK`, no foreign-key enforcement by default,
 * and — most importantly — transactional DDL, which is exactly the property MySQL
 * does *not* have and which the whole idempotence rule in {@see Migrator} exists
 * to work around. A green SQLite run would have made that rule look unnecessary.
 *
 * ## Disposable, enforced
 *
 * {@see connect()} refuses any database whose name does not end in `_test`. These
 * suites truncate tables between tests; pointed at a shared or production
 * database they would destroy it, and a naming rule is a cheap way to make that
 * impossible rather than merely discouraged.
 */
final class TestDatabase
{
    public const DSN_VARIABLE = 'ESZTER_TEST_DB_DSN';
    private const USERNAME_VARIABLE = 'ESZTER_TEST_DB_USERNAME';
    private const PASSWORD_VARIABLE = 'ESZTER_TEST_DB_PASSWORD';

    private static ?Database $shared = null;

    public static function isConfigured(): bool
    {
        return self::environment(self::DSN_VARIABLE) !== null;
    }

    public static function skipReason(): string
    {
        return \sprintf(
            'No test database is configured. Set %s, %s and %s to a disposable MySQL '
            . 'database whose name ends in `_test`.',
            self::DSN_VARIABLE,
            self::USERNAME_VARIABLE,
            self::PASSWORD_VARIABLE,
        );
    }

    public static function settings(): DatabaseSettings
    {
        $dsn = self::environment(self::DSN_VARIABLE);

        if ($dsn === null) {
            throw new \RuntimeException(self::skipReason());
        }

        return new DatabaseSettings(
            $dsn,
            self::environment(self::USERNAME_VARIABLE) ?? '',
            self::environment(self::PASSWORD_VARIABLE) ?? '',
        );
    }

    /** One connection for the whole run, so a test can isolate itself in a transaction. */
    public static function connect(): Database
    {
        if (self::$shared !== null) {
            return self::$shared;
        }

        $settings = self::settings();
        $name = $settings->databaseName();

        if ($name === null || !str_ends_with($name, '_test')) {
            throw new \RuntimeException(\sprintf(
                'Refusing to run destructive tests against `%s`: the database name must end in `_test`.',
                $name ?? '(unnamed)',
            ));
        }

        if ($settings->driver() !== 'mysql') {
            throw new \RuntimeException(\sprintf(
                'These gates must run against MySQL, the engine the target host runs; got `%s`.',
                $settings->driver(),
            ));
        }

        return self::$shared = new Database($settings);
    }

    /** A connection of its own, for tests that need two. */
    public static function connectSeparately(): Database
    {
        self::connect();

        return new Database(self::settings());
    }

    /**
     * A second, equally disposable database — the clean target a restore proof
     * needs (ESZ-083).
     *
     * Derived from `ESZTER_TEST_DB_DSN` by renaming the schema rather than being a
     * variable of its own, so there is one thing to configure and no way to point
     * the two halves of a restore test at two different servers by accident. The
     * name keeps the `_test` suffix {@see connect()} insists on, because this is
     * the database a restore proof empties and refills.
     *
     * Created on demand: a restore is only proved by restoring into somewhere that
     * held nothing, and "nothing" has to include the schema.
     */
    public static function connectRestoreTarget(): Database
    {
        $settings = self::restoreTargetSettings();
        $name = $settings->databaseName();

        if ($name === null || !str_ends_with($name, '_test')) {
            throw new \RuntimeException('The restore target database must also end in `_test`.');
        }

        // Created through the primary connection, which the suite has already
        // established is disposable.
        self::connect()->executeRaw(
            'CREATE DATABASE IF NOT EXISTS `' . str_replace('`', '``', $name) . '`'
            . ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
            'create restore target',
        );

        return new Database($settings);
    }

    public static function restoreTargetSettings(): DatabaseSettings
    {
        $settings = self::settings();
        $name = $settings->databaseName();

        if ($name === null) {
            throw new \RuntimeException('ESZTER_TEST_DB_DSN names no database.');
        }

        return new DatabaseSettings(
            str_replace(
                'dbname=' . $name,
                'dbname=' . substr($name, 0, -\strlen('_test')) . '_restore_test',
                $settings->dsn,
            ),
            $settings->username,
            $settings->password,
        );
    }

    public static function migrationsDirectory(): string
    {
        return \dirname(__DIR__, 2) . '/migrations';
    }

    public static function migrator(
        Database $database,
        ?Clock $clock = null,
        ?string $directory = null,
        int $lockTimeoutSeconds = Migrator::DEFAULT_LOCK_TIMEOUT_SECONDS,
    ): Migrator {
        return new Migrator(
            $database,
            $directory ?? self::migrationsDirectory(),
            $clock ?? new SystemClock(),
            $lockTimeoutSeconds,
        );
    }

    /**
     * Drops every table, returning the database to empty.
     *
     * Foreign-key checks are suspended for the duration, so the order tables are
     * dropped in does not matter — with `admin_sessions` referencing
     * `admin_accounts`, any fixed order would break the moment a table is added.
     */
    public static function dropEverything(Database $database): void
    {
        $database->executeRaw('SET FOREIGN_KEY_CHECKS = 0', 'disable fk checks');

        foreach ($database->fetchAll('SHOW TABLES') as $row) {
            /** @var mixed $table */
            $table = reset($row);

            if (!\is_string($table)) {
                continue;
            }

            // Interpolated, and it must be: a table name cannot be a bound
            // parameter. The value comes from `SHOW TABLES` on a database this
            // class has already established is disposable, never from a caller.
            $database->executeRaw(
                'DROP TABLE IF EXISTS `' . str_replace('`', '``', $table) . '`',
                'drop table',
            );
        }

        $database->executeRaw('SET FOREIGN_KEY_CHECKS = 1', 'enable fk checks');
    }

    /** Empties the data tables without touching the schema. */
    public static function truncateData(Database $database): void
    {
        $database->executeRaw('SET FOREIGN_KEY_CHECKS = 0', 'disable fk checks');
        foreach (
            [
                'rate_limit_buckets',
                'notification_jobs',
                'bookings',
                'booking_history',
                'availability_exception_windows',
                'availability_exceptions',
                'availability_rules',
                'booking_services',
                'system_settings',
                'admin_sessions',
                'admin_accounts',
            ] as $table
        ) {
            $database->executeRaw("TRUNCATE TABLE {$table}", "truncate {$table}");
        }
        $database->executeRaw('SET FOREIGN_KEY_CHECKS = 1', 'enable fk checks');
    }

    private static function environment(string $name): ?string
    {
        // getenv() returns false when the variable is absent, and an array only
        // when called with no name at all.
        $value = getenv($name);

        return \is_string($value) && trim($value) !== '' ? trim($value) : null;
    }
}
