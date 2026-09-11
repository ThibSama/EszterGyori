<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Database\Database;
use Eszter\Database\DatabaseException;
use Eszter\Database\Migrator;
use Eszter\Notification\NotificationPolicy;
use Eszter\Retention\RetentionPolicy;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/**
 * The `sql:migrations` gate (ESZ-023).
 *
 * "Every migration applies to an empty database in order, is idempotent on
 * re-run, and leaves schema_migrations consistent. Runs against a disposable
 * database, never a shared one." — `docs/v1-quality-gates.md`.
 *
 * Against real MySQL, because the property that makes the design what it is —
 * DDL committing implicitly, so a migration cannot be atomic — is a MySQL
 * property. On an engine with transactional DDL every test here would pass for
 * the wrong reason.
 */
#[Group('sql')]
final class MigrationTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private Database $database;

    protected function setUp(): void
    {
        if (!TestDatabase::isConfigured()) {
            self::markTestSkipped(TestDatabase::skipReason());
        }

        $this->database = TestDatabase::connect();
        TestDatabase::dropEverything($this->database);
    }

    protected function tearDown(): void
    {
        if (isset($this->database)) {
            TestDatabase::dropEverything($this->database);
        }
    }

    public function testEveryMigrationAppliesToAnEmptyDatabaseInOrder(): void
    {
        $migrator = $this->migrator();

        $applied = $migrator->migrate();

        self::assertSame(array_column($migrator->available(), 'version'), $applied);
        self::assertSame($applied, $migrator->appliedVersions());
        self::assertSame([], $migrator->pendingVersions());

        // Ordered, and ordered *by version* rather than by whatever order the
        // filesystem handed the files back in. `admin_sessions` has a foreign key
        // onto `admin_accounts`, so the wrong order is not a style question.
        $sorted = $applied;
        sort($sorted, SORT_STRING);
        self::assertSame($sorted, $applied);

        self::assertSame(
            ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008',
             '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018', '0019', '0020',
             '0021', '0022'],
            $applied,
        );
    }

    public function testRunningMigrationsTwiceAppliesNothingTheSecondTime(): void
    {
        $first = $this->migrator()->migrate();
        $second = $this->migrator()->migrate();

        self::assertNotSame([], $first);
        self::assertSame([], $second, 'a second run applied something');
        self::assertSame($first, $this->migrator()->appliedVersions());

        // And the registry did not gain a duplicate row per version.
        $rows = $this->database->fetchAll(
            'SELECT version, COUNT(*) AS n FROM ' . Migrator::TABLE . ' GROUP BY version',
        );

        foreach ($rows as $row) {
            self::assertSame(1, (int) $row['n'], (string) $row['version']);
        }
    }

    public function testAHalfAppliedMigrationCompletesOnTheNextRun(): void
    {
        // This is the failure MySQL actually produces: DDL commits implicitly, so
        // a migration that dies part-way leaves its tables behind and no row in
        // schema_migrations. Simulated by deleting the row, which is exactly the
        // state such a crash leaves.
        $this->migrator()->migrate();

        $this->database->run(
            'DELETE FROM ' . Migrator::TABLE . ' WHERE version = :version',
            ['version' => '0002'],
        );

        self::assertSame(['0002'], $this->migrator()->pendingVersions());

        // Re-running must complete rather than fail on the table that already
        // exists. That is what `CREATE TABLE IF NOT EXISTS` buys, and it is the
        // whole reason `Migrator::assertIdempotentDdl()` insists on it.
        self::assertSame(['0002'], $this->migrator()->migrate());
        self::assertSame([], $this->migrator()->pendingVersions());
    }

    public function testEditingAnAppliedMigrationIsRefused(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations');

        try {
            file_put_contents(
                $directory . '/0001_thing.sql',
                'CREATE TABLE IF NOT EXISTS thing (id INT PRIMARY KEY);',
            );

            self::assertSame(['0001'], $this->migrator($directory)->migrate());

            // Same version, different content: the database this was applied to is
            // not the database the edited file describes.
            file_put_contents(
                $directory . '/0001_thing.sql',
                'CREATE TABLE IF NOT EXISTS thing (id BIGINT PRIMARY KEY);',
            );

            $this->expectException(DatabaseException::class);
            $this->expectExceptionMessageMatches('/forward-only/');

            $this->migrator($directory)->migrate();
        } finally {
            TestEnvironment::removeDirectory($directory);
        }
    }

    public function testASchemaAheadOfTheCodeIsRefused(): void
    {
        $this->migrator()->migrate();

        // The signature of an application rolled back without its schema.
        $this->database->run(
            'INSERT INTO ' . Migrator::TABLE . ' (version, name, checksum, applied_at)'
            . ' VALUES (:v, :n, :c, :a)',
            ['v' => '9999', 'n' => 'from_the_future', 'c' => str_repeat('0', 64), 'a' => self::NOW],
        );

        $this->expectException(DatabaseException::class);
        $this->expectExceptionMessageMatches('/ahead of the code/');

        $this->migrator()->migrate();
    }

    public function testNonIdempotentDdlIsRefusedBeforeItIsApplied(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations');

        try {
            // No `IF NOT EXISTS`: safe once, fatal on the re-run that a
            // half-applied deploy makes necessary.
            file_put_contents($directory . '/0001_unsafe.sql', 'CREATE TABLE unsafe (id INT);');

            $this->expectException(DatabaseException::class);
            $this->expectExceptionMessageMatches('/safe to re-run/');

            $this->migrator($directory)->migrate();
        } finally {
            TestEnvironment::removeDirectory($directory);
            // The refusal happens at read time, so nothing was created. Asserting
            // it is what proves the check runs *before* the deploy, not after.
            self::assertSame(
                [],
                $this->database->fetchAll("SHOW TABLES LIKE 'unsafe'"),
            );
        }
    }

    public function testAnUnsafeUpdateMigrationIsRefusedBeforeExecution(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations');

        try {
            // ESZ-112: a bare UPDATE is not repeat-safe DML. A migration that
            // fails part-way runs again, and the second run of an UPDATE can
            // touch different rows — nothing in the statement makes the guard
            // able to verify otherwise, so it is refused like unguarded DDL.
            file_put_contents(
                $directory . '/0001_unsafe.sql',
                "CREATE TABLE IF NOT EXISTS t (id INT);\nUPDATE t SET id = id + 1;",
            );

            $this->expectException(DatabaseException::class);
            $this->expectExceptionMessageMatches('/mechanically safe/');

            $this->migrator($directory)->migrate();
        } finally {
            TestEnvironment::removeDirectory($directory);
            // The whole file is scanned at read time, before any statement
            // runs: the guarded CREATE beside the UPDATE never applied either.
            self::assertSame(
                [],
                $this->database->fetchAll("SHOW TABLES LIKE 't'"),
            );
        }
    }

    public function testAnUnsafeDeleteMigrationIsRefusedBeforeExecution(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations');

        try {
            // Same rule, DELETE side (ESZ-112): deleting rows is a mutation
            // whose repetition the guard cannot verify, so it never executes.
            file_put_contents(
                $directory . '/0001_unsafe.sql',
                "CREATE TABLE IF NOT EXISTS t (id INT);\nDELETE FROM t WHERE id = 1;",
            );

            $this->expectException(DatabaseException::class);
            $this->expectExceptionMessageMatches('/mechanically safe/');

            $this->migrator($directory)->migrate();
        } finally {
            TestEnvironment::removeDirectory($directory);
            self::assertSame(
                [],
                $this->database->fetchAll("SHOW TABLES LIKE 't'"),
            );
        }
    }

    public function testUnrecognisedRowMutatingDmlIsRefusedBeforeExecution(): void
    {
        // REPLACE INTO and TRUNCATE carry the same property as UPDATE/DELETE
        // (ESZ-112): no guarded form the migrator recognises, so repeated
        // execution cannot be verified mechanically. Each gets its own
        // directory because the guard stops at the first offending statement.
        foreach (
            [
                'REPLACE INTO t (id) VALUES (1)',
                'TRUNCATE TABLE t',
            ] as $statement
        ) {
            $directory = TestEnvironment::makeTempDirectory('eszter-migrations');

            try {
                file_put_contents(
                    $directory . '/0001_unsafe.sql',
                    "CREATE TABLE IF NOT EXISTS t (id INT);\n{$statement};",
                );

                try {
                    $this->migrator($directory)->migrate();
                    self::fail("The statement `{$statement}` should have been refused.");
                } catch (DatabaseException $exception) {
                    self::assertStringContainsString(
                        'mechanically safe',
                        $exception->getMessage(),
                        $statement,
                    );
                }
            } finally {
                TestEnvironment::removeDirectory($directory);
                self::assertSame(
                    [],
                    $this->database->fetchAll("SHOW TABLES LIKE 't'"),
                );
            }
        }
    }

    public function testAMisnamedMigrationFileIsRefusedRatherThanSkipped(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations');

        try {
            // Would sort before `0002` in some orderings and after it in others,
            // and a "skip what you don't recognise" reader would never run it.
            file_put_contents($directory . '/7_thing.sql', 'CREATE TABLE IF NOT EXISTS t (id INT);');

            $this->expectException(DatabaseException::class);
            $this->expectExceptionMessageMatches('/NNNN_name\.sql/');

            $this->migrator($directory)->migrate();
        } finally {
            TestEnvironment::removeDirectory($directory);
        }
    }

    public function testTheRegistryRecordsWhatWasAppliedAndItsChecksum(): void
    {
        $this->migrator()->migrate();

        $rows = $this->database->fetchAll(
            'SELECT version, name, checksum, applied_at FROM ' . Migrator::TABLE . ' ORDER BY version',
        );
        $available = array_column($this->migrator()->available(), null, 'version');

        self::assertCount(\count($available), $rows);

        foreach ($rows as $row) {
            /** @var string $version */
            $version = $row['version'];

            self::assertSame($available[$version]['name'], $row['name']);
            self::assertSame($available[$version]['checksum'], $row['checksum']);
            self::assertSame(self::NOW, $row['applied_at']);
        }
    }

    public function testTheSchemaIsUtf8mb4AndCarriesTheColumnsTheCodeReads(): void
    {
        $this->migrator()->migrate();

        // `docs/hetzner-target-architecture.md` §8: utf8mb4 throughout. The content
        // pipeline guarantees NFC UTF-8 end to end and the database must not be the
        // component that breaks it.
        foreach (
            [
                'admin_accounts',
                'admin_sessions',
                'booking_services',
                'availability_rules',
                'availability_exceptions',
                'availability_exception_windows',
                'bookings',
                'booking_resource_locks',
                'booking_history',
                'system_settings',
                'notification_jobs',
            ] as $table
        ) {
            $create = $this->database->fetchOne(
                'SHOW CREATE TABLE `' . $table . '`',
            );

            self::assertIsArray($create);
            /** @var string $sql */
            $sql = $create['Create Table'];

            self::assertStringContainsString('utf8mb4', $sql, $table);
            self::assertStringContainsString('ENGINE=InnoDB', $sql, $table);
        }

        // The email index must be byte-exact, or `e@x.test` and `é@x.test` would
        // collide under the table's accent-insensitive default collation and one
        // of two legitimate people could not have an account.
        $email = $this->column('admin_accounts', 'email');
        self::assertSame('utf8mb4_bin', $email['COLLATION_NAME']);

        $id = $this->column('admin_sessions', 'id');
        self::assertSame('ascii_bin', $id['COLLATION_NAME']);

        foreach (
            [
                'admin_accounts' => [
                    'id', 'email', 'password_hash', 'is_enabled',
                    'created_at', 'updated_at', 'last_login_at',
                ],
                'admin_sessions' => [
                    'id', 'account_id', 'csrf_token', 'created_at',
                    'last_seen_at', 'expires_at', 'absolute_expires_at',
                ],
                'booking_services' => [
                    'service_key', 'booking_label', 'description', 'image_src', 'duration_minutes',
                    'buffer_before_minutes', 'buffer_after_minutes', 'is_active',
                    'created_at', 'updated_at',
                ],
                'availability_rules' => [
                    'id', 'weekday_iso', 'start_local', 'end_local', 'valid_from',
                    'valid_until', 'fold_utc_offset', 'is_active', 'created_at', 'updated_at',
                ],
                'availability_exceptions' => [
                    'id', 'exception_date', 'exception_kind', 'start_local',
                    'end_local', 'fold_utc_offset', 'note', 'created_at', 'updated_at',
                ],
                'availability_exception_windows' => [
                    'id', 'exception_id', 'position', 'start_local', 'end_local',
                    'fold_utc_offset',
                ],
                'bookings' => [
                    'id', 'reference', 'service_key', 'state', 'starts_at_utc',
                    'ends_at_utc', 'timezone_name', 'customer_name', 'customer_email',
                    'customer_phone', 'customer_note', 'consent_at_utc', 'consent_notice_id',
                    'privacy_notice_id', 'privacy_notice_presented_at_utc',
                    'cancelled_at_utc', 'cancellation_reason', 'customer_data_erased_at',
                    'created_at', 'updated_at', 'state_changed_at',
                ],
                'booking_resource_locks' => ['resource_key'],
                'booking_history' => [
                    'id', 'booking_id', 'event_type', 'actor_type', 'details_json', 'occurred_at',
                ],
                'system_settings' => ['setting_key', 'value_json', 'created_at', 'updated_at'],
                'notification_jobs' => [
                    'id', 'idempotency_key', 'booking_id', 'channel', 'job_type',
                    'due_at_utc', 'next_attempt_at_utc', 'status', 'attempts',
                    'last_error_code', 'sent_at_utc', 'lease_owner',
                    'lease_expires_at_utc', 'created_at', 'updated_at', 'status_changed_at',
                ],
            ] as $table => $columns
        ) {
            foreach ($columns as $column) {
                self::assertNotSame([], $this->column($table, $column), "{$table}.{$column}");
            }
        }
    }

    public function testBookingSchemaHasOnlyRuleDrivenAvailabilityAndNecessaryIndexes(): void
    {
        $this->migrator()->migrate();

        self::assertSame([], $this->database->fetchAll("SHOW TABLES LIKE '%slot%'"));

        foreach (
            [
                'booking_services' => ['PRIMARY', 'ix_booking_services_active_key'],
                'booking_service_combinations' => ['PRIMARY', 'ix_booking_service_combinations_active'],
                'availability_rules' => [
                    'PRIMARY', 'uq_availability_rules_window', 'ix_availability_rules_lookup',
                ],
                'availability_exceptions' => ['PRIMARY', 'uq_availability_exceptions_date'],
                // ESZ-152: constraints are read by date-range overlap only.
                'availability_constraints' => ['PRIMARY', 'ix_availability_constraints_range'],
                'availability_exception_windows' => [
                    'PRIMARY', 'uq_availability_exception_windows_position',
                    'ix_availability_exception_windows_order',
                ],
                'bookings' => [
                    'PRIMARY', 'uq_bookings_reference', 'ix_bookings_service_start',
                    'ix_bookings_starts_reference', 'ix_bookings_state_start',
                    // ESZ-150: the index InnoDB keeps for the combination foreign key.
                    'fk_bookings_combination',
                ],
                'booking_resource_locks' => ['PRIMARY'],
                // ESZ-153: keyed by the booking id, which also serves its FK.
                'booking_buffer_snapshots' => ['PRIMARY'],
                'booking_history' => ['PRIMARY', 'ix_booking_history_booking_order'],
                'system_settings' => ['PRIMARY'],
                // ESZ-163: the register is read newest-first by id and purged
                // by (status, closed_at_utc); the references by request.
                'privacy_requests' => ['PRIMARY', 'ix_privacy_requests_purge'],
                'privacy_request_bookings' => ['PRIMARY', 'uq_privacy_request_bookings_position'],
                'notification_jobs' => [
                    'PRIMARY', 'uq_notification_jobs_idempotency',
                    'ix_notification_jobs_claim', 'ix_notification_jobs_lease',
                    'ix_notification_jobs_due', 'ix_notification_jobs_booking',
                ],
            ] as $table => $expected
        ) {
            $indexes = array_values(array_unique(array_map(
                static fn (array $row): string => (string) $row['Key_name'],
                $this->database->fetchAll("SHOW INDEX FROM `{$table}`"),
            )));
            sort($indexes);
            sort($expected);
            self::assertSame($expected, $indexes, $table);
        }
    }

    public function testMySqlEnforcesBookingServiceAvailabilityAndBookingConstraints(): void
    {
        $this->migrator()->migrate();

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at)'
            . " VALUES ('brows', 'Brows', 0, 0, 0, 1, :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        ));

        $this->database->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at)'
            . " VALUES ('brows', 'Brows', 60, 0, 0, 1, :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        );

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO availability_rules'
            . ' (weekday_iso, start_local, end_local, valid_from, valid_until, created_at, updated_at)'
            . " VALUES (8, '09:00:00', '10:00:00', '2026-01-01', '2026-12-31', :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        ));

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO availability_rules'
            . ' (weekday_iso, start_local, end_local, fold_utc_offset, created_at, updated_at)'
            . " VALUES (1, '09:00:00', '10:00:00', '+03:00', :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        ));

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO availability_exceptions'
            . ' (exception_date, exception_kind, start_local, end_local, created_at, updated_at)'
            . " VALUES ('2026-07-14', 'closed', '09:00:00', NULL, :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        ));

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO availability_exception_windows'
            . ' (exception_id, position, start_local, end_local)'
            . " VALUES (999999, 2, '09:00:00', '10:00:00')",
        ));

        $this->database->run(
            'INSERT INTO availability_exceptions'
            . ' (exception_date, exception_kind, start_local, end_local, created_at, updated_at)'
            . " VALUES ('2026-07-14', 'closed', NULL, NULL, :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        );
        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO availability_exceptions'
            . ' (exception_date, exception_kind, start_local, end_local, created_at, updated_at)'
            . " VALUES ('2026-07-14', 'closed', NULL, NULL, :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        ));

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, consent_at_utc, created_at, updated_at, state_changed_at)'
            . " VALUES ('bk_22222222222222222222222222222222', 'lips', 'confirmed',"
            . " '2026-01-01 10:00:00.000', '2026-01-01 11:00:00.000', 'Europe/Paris',"
            . " 'Test', 'test@example.test', '2026-01-01 09:00:00.000', :created, :updated, :changed)",
            ['created' => self::NOW, 'updated' => self::NOW, 'changed' => self::NOW],
        ));

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, consent_at_utc, created_at, updated_at, state_changed_at)'
            . " VALUES ('bk_00000000000000000000000000000000', 'brows', 'confirmed',"
            . " '2026-01-01 10:00:00.000', '2026-01-01 11:00:00.000', 'UTC',"
            . " 'Test', 'test@example.test', '2026-01-01 09:00:00.000', :created, :updated, :changed)",
            ['created' => self::NOW, 'updated' => self::NOW, 'changed' => self::NOW],
        ));

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, consent_at_utc, cancelled_at_utc,'
            . ' created_at, updated_at, state_changed_at)'
            . " VALUES ('bk_33333333333333333333333333333333', 'brows', 'confirmed',"
            . " '2026-01-01 10:00:00.000', '2026-01-01 11:00:00.000', 'Europe/Paris',"
            . " 'Test', 'test@example.test', '2026-01-01 09:00:00.000',"
            . " '2026-01-01 09:30:00.000', :created, :updated, :changed)",
            ['created' => self::NOW, 'updated' => self::NOW, 'changed' => self::NOW],
        ));

        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, consent_at_utc, created_at, updated_at, state_changed_at)'
            . " VALUES ('bk_11111111111111111111111111111111', 'brows', 'completed',"
            . " '2026-01-01 10:00:00.000', '2026-01-01 11:00:00.000', 'Europe/Paris',"
            . " 'Test', 'test@example.test', '2026-01-01 09:00:00.000', :created, :updated, :changed)",
            ['created' => self::NOW, 'updated' => self::NOW, 'changed' => self::NOW],
        ));
    }

    public function testBookingSerializationRowAndHistoryConstraintsExist(): void
    {
        $this->migrator()->migrate();

        self::assertSame(
            [['resource_key' => 'primary']],
            $this->database->fetchAll('SELECT resource_key FROM booking_resource_locks'),
        );
        $this->expectConstraintFailure(fn () => $this->database->run(
            "INSERT INTO booking_resource_locks (resource_key) VALUES ('secondary')",
        ));
        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO booking_history'
            . ' (booking_id, event_type, actor_type, details_json, occurred_at)'
            . " VALUES (999999, 'created', 'public', JSON_OBJECT(), :occurred)",
            ['occurred' => self::NOW],
        ));
    }

    public function testTheSessionForeignKeyCascadesFromTheAccount(): void
    {
        $this->migrator()->migrate();

        $this->database->run(
            'INSERT INTO admin_accounts (email, password_hash, is_enabled, created_at, updated_at)'
            . ' VALUES (:e, :h, 1, :created, :updated)',
            ['e' => 'a@example.test', 'h' => 'x', 'created' => self::NOW, 'updated' => self::NOW],
        );
        $accountId = (int) $this->database->pdo()->lastInsertId();

        $this->database->run(
            'INSERT INTO admin_sessions'
            . ' (id, account_id, csrf_token, created_at, last_seen_at, expires_at, absolute_expires_at)'
            // One placeholder per position, even though every timestamp here is
            // the same value: `ATTR_EMULATE_PREPARES` is off, so PDO cannot reuse
            // a name. Writing them out is also how this test stays honest about
            // what the production statements have to look like.
            . ' VALUES (:id, :a, :c, :created, :seen, :expires, :absolute)',
            [
                'id' => str_repeat('a', 64),
                'a' => $accountId,
                'c' => str_repeat('b', 64),
                'created' => self::NOW,
                'seen' => self::NOW,
                'expires' => self::NOW,
                'absolute' => self::NOW,
            ],
        );

        $this->database->run('DELETE FROM admin_accounts WHERE id = :id', ['id' => $accountId]);

        // Deleting an account must not orphan its sessions into rows that point at
        // nothing and would be invisible to `destroyForAccount`.
        self::assertSame([], $this->database->fetchAll('SELECT id FROM admin_sessions'));
    }

    /**
     * ESZ-070 — the notification queue's own constraints, on real MySQL.
     *
     * Every one of these is a rule the runner also enforces in PHP. Asserting
     * them here is not duplication: the runner is one process among several and
     * a future second writer — a backfill script, an admin action — would not go
     * through it. The database is where "there is exactly one job per
     * idempotency key" stops being a convention.
     */
    public function testMySqlEnforcesTheNotificationQueueConstraints(): void
    {
        $this->migrator()->migrate();
        $bookingId = $this->seedBookingForNotifications();

        // The relation is real: a job cannot point at a booking that is not there.
        $this->expectConstraintFailure(fn () => $this->insertJob(999_999, ['key' => 'orphan.email.confirm']));

        // Enum sets.
        $this->expectConstraintFailure(
            fn () => $this->insertJob($bookingId, ['key' => 'chan.bad.value', 'channel' => 'pigeon']),
        );
        $this->expectConstraintFailure(
            fn () => $this->insertJob($bookingId, ['key' => 'type.bad.value', 'type' => 'booking_haiku']),
        );
        $this->expectConstraintFailure(
            fn () => $this->insertJob($bookingId, ['key' => 'status.bad.value', 'status' => 'queued']),
        );

        // The idempotency key has a shape, so a caller cannot invent one that is
        // unique by accident — an empty string, or a UUID with braces.
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, ['key' => 'short']));
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, ['key' => 'HAS.UPPER.CASE.HERE']));

        // The diagnostic column is structurally a code. This is the constraint
        // that makes "no customer data in the error column" a schema fact.
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, [
            'key' => 'errcode.bad.value',
            'error' => 'smtp 550 no mailbox for cliente@example.test',
        ]));

        // `sent` and `sent_at_utc` agree in both directions.
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, [
            'key' => 'sent.without.instant',
            'status' => 'sent',
        ]));
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, [
            'key' => 'pending.with.instant',
            'sent_at' => '2026-06-13 12:00:00.000',
        ]));

        // A lease exists exactly while the job is claimed.
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, [
            'key' => 'processing.without.lease',
            'status' => 'processing',
            'attempts' => 1,
        ]));
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, [
            'key' => 'pending.with.lease',
            'lease_owner' => 'host.1.abcdef',
            'lease_expires' => '2026-06-13 12:02:00.000',
        ]));

        // A claimed job has been attempted, and the attempt budget is bounded by
        // the same number the frozen retry policy uses.
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, [
            'key' => 'processing.zero.attempts',
            'status' => 'processing',
            'attempts' => 0,
            'lease_owner' => 'host.1.abcdef',
            'lease_expires' => '2026-06-13 12:02:00.000',
        ]));
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, [
            'key' => 'attempts.above.budget',
            'attempts' => 6,
        ]));

        // And the happy row, so the refusals above are not all being produced by
        // one unrelated mistake in the fixture.
        $this->insertJob($bookingId, ['key' => 'good.email.confirmation']);

        // Uniqueness is what makes a duplicate enqueue a reuse.
        $this->expectConstraintFailure(fn () => $this->insertJob($bookingId, ['key' => 'good.email.confirmation']));

        self::assertSame(
            1,
            (int) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM notification_jobs')['n'] ?? 0),
        );
    }

    /**
     * ESZ-070 — notification history outlives nothing quietly.
     *
     * `ON DELETE CASCADE` would be the convenient choice and the wrong one: the
     * row is the record that a customer was told something, and it must not
     * vanish with the appointment. V1 never deletes a booking, so this asserts a
     * guarantee against a future delete path rather than a current one.
     */
    public function testDeletingABookingIsRefusedWhileNotificationHistoryReferencesIt(): void
    {
        $this->migrator()->migrate();
        $bookingId = $this->seedBookingForNotifications();
        $this->insertJob($bookingId, [
            'key' => 'retained.email.confirmation',
            'status' => 'sent',
            'sent_at' => '2026-06-13 12:00:00.000',
        ]);

        $this->expectConstraintFailure(fn () => $this->database->run(
            'DELETE FROM bookings WHERE id = :id',
            ['id' => $bookingId],
        ));

        self::assertSame(
            1,
            (int) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM notification_jobs')['n'] ?? 0),
        );
        self::assertSame(
            1,
            (int) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n'] ?? 0),
        );
    }

    public function testConcurrentMigrationRunsDoNotCollide(): void
    {
        // The advisory lock, exercised on two real connections. Without it two
        // overlapping deploys race to create the same tables and one of them dies
        // on a duplicate-key insert into schema_migrations.
        $other = TestDatabase::connectSeparately();

        $held = $other->fetchOne(
            'SELECT GET_LOCK(:name, 1) AS acquired',
            ['name' => Migrator::LOCK_NAME],
        );
        self::assertSame(1, $held['acquired'] ?? null);

        try {
            $this->expectException(DatabaseException::class);
            $this->expectExceptionMessageMatches('/Another process/');

            // The one-second wait is not what is being asserted — the refusal is.
            // The real timeout is 30s, which would make this gate 30s slower to
            // prove the same sentence.
            TestDatabase::migrator($this->database, new FrozenClock(self::NOW), null, 1)->migrate();
        } finally {
            $other->run('SELECT RELEASE_LOCK(:name)', ['name' => Migrator::LOCK_NAME]);
        }
    }

    // --- ESZ-142: the consent-notice id column and CHECK -------------------

    /**
     * Migration 0014 bounds the consent notice id to the catalog's bounded
     * ASCII shape: the column is ascii_bin (non-ASCII bytes cannot be stored),
     * NULL stays legal as the explicit pre-catalog marker, and the CHECK
     * refuses ids the pattern does not admit — an over-long id, or one
     * carrying uppercase where the machine pattern says lowercase.
     */
    public function testMigration0014BoundsTheConsentNoticeIdColumn(): void
    {
        $this->migrator()->migrate();
        $seedId = $this->seedBookingForNotifications();

        // The pre-catalog marker: a row inserted without the column is NULL.
        $legacy = $this->database->fetchOne(
            'SELECT consent_notice_id, consent_at_utc FROM bookings WHERE id = :id',
            ['id' => $seedId],
        );
        self::assertNull($legacy['consent_notice_id']);
        self::assertSame('2026-06-13 09:00:00.000', $legacy['consent_at_utc']);

        // The column really is bounded ASCII.
        $column = $this->column('bookings', 'consent_notice_id');
        self::assertSame('ascii', $column['CHARACTER_SET_NAME']);
        self::assertSame('ascii_bin', $column['COLLATION_NAME']);
        $check = $this->checkClause('bookings', 'chk_bookings_consent_notice_id');
        self::assertNotNull($check);
        // MySQL 8.4 canonicalizes CHECK text (REGEXP becomes regexp_like,
        // backticked identifiers, lowercase keywords) — assert the semantics.
        self::assertStringContainsString(
            'is null',
            (string) $check,
            'NULL must stay legal as the explicit legacy marker',
        );
        self::assertStringContainsString(
            'regexp_like',
            (string) $check,
            'the CHECK must restate the catalog id pattern',
        );
        self::assertStringContainsString(
            '^[a-z0-9][a-z0-9_-]{0,63}$',
            (string) $check,
            'the CHECK must restate the catalog id pattern',
        );

        // A well-formed catalog id is accepted on insert…
        $this->seedBookingWithNotice('bk_99999999999999999999999999999991', 'booking-consent-v1');

        // …an over-long id is refused…
        $this->expectConstraintFailure(fn () => $this->seedBookingWithNotice(
            'bk_99999999999999999999999999999992',
            str_repeat('x', 65),
        ));

        // …and so is an id outside the lowercase machine pattern.
        $this->expectConstraintFailure(fn () => $this->seedBookingWithNotice(
            'bk_99999999999999999999999999999993',
            'Booking-Consent-V1',
        ));
    }

    /**
     * ESZ-142, proof 5 — applying 0014 over a database that already holds
     * bookings must preserve them without inventing provenance: pre-existing
     * rows keep their consent_at_utc untouched and a NULL consent_notice_id,
     * and only new inserts can carry the id.
     */
    public function testMigration0014PreservesPreExistingBookingsWithoutInventingProvenance(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations-esz142');

        try {
            $migrations = TestDatabase::migrationsDirectory();
            foreach ((glob($migrations . '/000[1-9]_*.sql') ?: []) as $file) {
                copy($file, $directory . '/' . basename($file));
            }
            foreach ((glob($migrations . '/001[0-3]_*.sql') ?: []) as $file) {
                copy($file, $directory . '/' . basename($file));
            }

            // The pre-0014 world: schema 0001-0013, with bookings already live.
            self::assertSame(
                ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008',
                 '0009', '0010', '0011', '0012', '0013'],
                $this->migrator($directory)->migrate(),
            );
            $this->database->run(
                'INSERT INTO booking_services'
                . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
                . ' buffer_after_minutes, is_active, created_at, updated_at)'
                . " VALUES ('lips', 'Lèvres', 60, 0, 0, 1, :created, :updated)",
                ['created' => self::NOW, 'updated' => self::NOW],
            );
            $this->database->run(
                'INSERT INTO bookings'
                . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
                . ' customer_name, customer_email, consent_at_utc, created_at, updated_at, state_changed_at)'
                . " VALUES ('bk_88888888888888888888888888888881', 'lips', 'confirmed',"
                . " '2026-06-15 10:00:00.000', '2026-06-15 11:00:00.000', 'Europe/Paris',"
                . " 'Cliente', 'cliente@example.test', '2026-06-13 09:00:00.000', :created, :updated, :changed)",
                ['created' => self::NOW, 'updated' => self::NOW, 'changed' => self::NOW],
            );

            // The deploy: 0014 lands and applies alone.
            copy($migrations . '/0014_booking_consent_notice.sql', $directory . '/0014_booking_consent_notice.sql');
            self::assertSame(['0014'], $this->migrator($directory)->migrate());
            self::assertSame([], $this->migrator($directory)->pendingVersions());

            // No provenance was invented: the pre-existing row still has its
            // exact consent instant and a NULL notice id.
            $legacy = $this->database->fetchOne(
                'SELECT consent_notice_id, consent_at_utc FROM bookings'
                . ' WHERE reference = :reference',
                ['reference' => 'bk_88888888888888888888888888888881'],
            );
            self::assertNull($legacy['consent_notice_id']);
            self::assertSame('2026-06-13 09:00:00.000', $legacy['consent_at_utc']);

            // While new bookings now carry the id beside their own instant.
            $this->seedBookingWithNotice('bk_88888888888888888888888888888882', 'booking-consent-v1');
            $fresh = $this->database->fetchOne(
                'SELECT consent_notice_id, consent_at_utc FROM bookings'
                . ' WHERE reference = :reference',
                ['reference' => 'bk_88888888888888888888888888888882'],
            );
            self::assertSame('booking-consent-v1', $fresh['consent_notice_id']);
            self::assertSame('2026-06-13 09:00:00.000', $fresh['consent_at_utc']);

            // And 0014 itself stays repeat-safe on re-run.
            self::assertSame([], $this->migrator($directory)->migrate());
        } finally {
            TestEnvironment::removeDirectory($directory);
        }
    }

    // --- ESZ-161: privacy notice evidence and the public reference shape ---

    /**
     * ESZ-161 — migration 0020 makes the consent instant nullable, adds the
     * privacy notice id and its presentation instant (bounded exactly like
     * the consent notice id), states the basis-evidence invariant, and lets
     * `reference` carry the current `XXXX-XXXX` shape beside the legacy
     * `bk_` one. Applied over a database that already holds consent-era
     * bookings, it rewrites none of them.
     */
    public function testMigration0020AddsPrivacyNoticeEvidenceAndTheCurrentReferenceShape(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations-esz161');

        try {
            $migrations = TestDatabase::migrationsDirectory();
            foreach ((glob($migrations . '/000[1-9]_*.sql') ?: []) as $file) {
                copy($file, $directory . '/' . basename($file));
            }
            foreach ((glob($migrations . '/001[0-9]_*.sql') ?: []) as $file) {
                copy($file, $directory . '/' . basename($file));
            }

            // The pre-0020 world: schema 0001-0019 with a consent-era booking.
            $applied = $this->migrator($directory)->migrate();
            self::assertSame('0019', end($applied));
            $this->seedBookingForNotifications();
            $this->seedBookingWithNotice('bk_77777777777777777777777777777771', 'booking-consent-v1');
            // The legacy shape is the only one admitted before the deploy.
            $this->expectConstraintFailure(fn () => $this->seedBookingWithNotice('XG73-UVK9', 'booking-consent-v1'));

            // The deploy: 0020 lands and applies alone.
            copy(
                $migrations . '/0020_booking_privacy_notice_and_public_reference.sql',
                $directory . '/0020_booking_privacy_notice_and_public_reference.sql',
            );
            self::assertSame(['0020'], $this->migrator($directory)->migrate());
            self::assertSame([], $this->migrator($directory)->pendingVersions());

            // Nothing was rewritten: the consent-era rows keep their exact
            // instant, notice id and reference, and gain NULL privacy facts.
            foreach (['bk_33333333333333333333333333333333', 'bk_77777777777777777777777777777771'] as $reference) {
                $legacy = $this->database->fetchOne(
                    'SELECT reference, consent_at_utc, consent_notice_id, privacy_notice_id,'
                    . ' privacy_notice_presented_at_utc FROM bookings WHERE reference = :reference',
                    ['reference' => $reference],
                );
                self::assertSame($reference, $legacy['reference']);
                self::assertSame('2026-06-13 09:00:00.000', $legacy['consent_at_utc']);
                self::assertNull($legacy['privacy_notice_id']);
                self::assertNull($legacy['privacy_notice_presented_at_utc']);
            }
            self::assertSame('booking-consent-v1', $this->database->fetchOne(
                'SELECT consent_notice_id FROM bookings WHERE reference = :reference',
                ['reference' => 'bk_77777777777777777777777777777771'],
            )['consent_notice_id']);

            // The columns: consent instant nullable, privacy id bounded ASCII,
            // reference a VARCHAR admitting both shapes.
            self::assertSame('YES', $this->column('bookings', 'consent_at_utc')['IS_NULLABLE']);
            $notice = $this->column('bookings', 'privacy_notice_id');
            self::assertSame('ascii', $notice['CHARACTER_SET_NAME']);
            self::assertSame('ascii_bin', $notice['COLLATION_NAME']);
            self::assertSame('YES', $notice['IS_NULLABLE']);
            self::assertSame('datetime', $this->column('bookings', 'privacy_notice_presented_at_utc')['DATA_TYPE']);
            self::assertSame('varchar', $this->column('bookings', 'reference')['DATA_TYPE']);
            self::assertNull($this->checkClause('bookings', 'chk_bookings_reference'));
            $shape = (string) $this->checkClause('bookings', 'chk_bookings_reference_shape');
            self::assertStringContainsString('bk_[0-9a-f]{32}', $shape);
            self::assertStringContainsString('[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}', $shape);
            self::assertStringContainsString(
                '^[a-z0-9][a-z0-9_-]{0,63}$',
                (string) $this->checkClause('bookings', 'chk_bookings_privacy_notice_id'),
            );
            self::assertNotNull($this->checkClause('bookings', 'chk_bookings_basis_evidence'));

            // A current-shape booking with privacy evidence and no consent
            // instant is accepted…
            $this->seedPrivacyBooking('XG73-UVK9', 'booking-privacy-v1');
            $fresh = $this->database->fetchOne(
                'SELECT reference, consent_at_utc, consent_notice_id, privacy_notice_id,'
                . ' privacy_notice_presented_at_utc FROM bookings WHERE reference = :reference',
                ['reference' => 'XG73-UVK9'],
            );
            self::assertSame('XG73-UVK9', $fresh['reference']);
            self::assertNull($fresh['consent_at_utc']);
            self::assertNull($fresh['consent_notice_id']);
            self::assertSame('booking-privacy-v1', $fresh['privacy_notice_id']);
            self::assertSame('2026-06-13 09:00:00.000', $fresh['privacy_notice_presented_at_utc']);
            // …a legacy-shape insert still is (nothing narrows the old shape)…
            $this->seedBookingWithNotice('bk_77777777777777777777777777777772', 'booking-consent-v1');
            // …and the UNIQUE key still holds for the new shape.
            $this->expectConstraintFailure(fn () => $this->seedPrivacyBooking('XG73-UVK9', 'booking-privacy-v1'));

            // Refused: ambiguous characters, lowercase, a bare eight without
            // the hyphen, a malformed notice id, a booking with no evidence
            // at all, and a half-set privacy pair.
            foreach (['XG70-UVK9', 'xg73-uvk9', 'XG73UVK9', 'XG73-UVKI'] as $malformed) {
                $this->expectConstraintFailure(fn () => $this->seedPrivacyBooking($malformed, 'booking-privacy-v1'));
            }
            $this->expectConstraintFailure(fn () => $this->seedPrivacyBooking('ABCD-EFGH', 'Booking-Privacy-V1'));
            $this->expectConstraintFailure(fn () => $this->seedPrivacyBooking('ABCD-EFGH', null));
            $this->expectConstraintFailure(fn () => $this->seedPrivacyBooking('ABCD-EFGH', 'booking-privacy-v1', null));

            // And 0020 itself stays repeat-safe on re-run.
            self::assertSame([], $this->migrator($directory)->migrate());
            self::assertSame('varchar', $this->column('bookings', 'reference')['DATA_TYPE']);
        } finally {
            TestEnvironment::removeDirectory($directory);
        }
    }

    /**
     * ESZ-161 correction — migration 0020's basis-evidence CHECK read "at
     * least one evidence" and so admitted a hybrid row carrying both a consent
     * instant and a privacy notice. Migration 0021 replaces it with the
     * exclusive invariant: exactly one of the historical path (consent
     * instant, notice id NULL or set, no privacy facts) and the current path
     * (no consent facts, the full privacy pair). Nothing is rewritten, and the
     * replacement is repeat-safe.
     */
    public function testMigration0021MakesTheBasisEvidenceCheckExclusive(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations-esz161-basis');

        try {
            $migrations = TestDatabase::migrationsDirectory();
            foreach (['000[1-9]_*.sql', '001[0-9]_*.sql', '0020_*.sql'] as $glob) {
                foreach ((glob($migrations . '/' . $glob) ?: []) as $file) {
                    copy($file, $directory . '/' . basename($file));
                }
            }

            // The 0020 world: the faulty CHECK admits a hybrid row.
            $applied = $this->migrator($directory)->migrate();
            self::assertSame('0020', end($applied));
            $this->seedBookingForNotifications();
            $instant = '2026-06-13 09:00:00.000';
            $consent = 'booking-consent-v1';
            $privacy = 'booking-privacy-v1';
            $this->seedBasisEvidenceBooking('bk_88888888888888888888888888888881', $instant, null, null, null);
            $this->seedBasisEvidenceBooking('bk_88888888888888888888888888888882', $instant, $consent, null, null);
            $this->seedBasisEvidenceBooking('HYBR-QRST', $instant, $consent, $privacy, $instant);
            // No deployed database holds such a row; the test alone removes
            // its proof of the defect before the corrected CHECK is added.
            $this->database->run('DELETE FROM bookings WHERE reference = :reference', ['reference' => 'HYBR-QRST']);

            // The deploy: 0021 lands and applies alone.
            foreach ((glob($migrations . '/0021_*.sql') ?: []) as $file) {
                copy($file, $directory . '/' . basename($file));
            }
            self::assertSame(['0021'], $this->migrator($directory)->migrate());
            self::assertSame([], $this->migrator($directory)->pendingVersions());

            // The replaced CHECK names the consent notice id (the exclusive
            // clause) and nothing was rewritten.
            $clause = (string) $this->checkClause('bookings', 'chk_bookings_basis_evidence');
            self::assertStringContainsString('consent_notice_id', $clause);
            self::assertSame(3, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n']);
            self::assertSame('booking-consent-v1', $this->database->fetchOne(
                'SELECT consent_notice_id FROM bookings WHERE reference = :reference',
                ['reference' => 'bk_88888888888888888888888888888882'],
            )['consent_notice_id']);

            // Accepted: the historical path with and without a consent notice
            // id, and the current path.
            $this->seedBasisEvidenceBooking('bk_88888888888888888888888888888883', $instant, null, null, null);
            $this->seedBasisEvidenceBooking('bk_88888888888888888888888888888884', $instant, $consent, null, null);
            $this->seedBasisEvidenceBooking('CURR-QRST', null, null, $privacy, $instant);

            // Refused: hybrids (consent instant and/or consent notice id
            // beside a privacy notice), a half-set privacy pair, and no
            // evidence at all.
            $refused = [
                [$instant, $consent, $privacy, $instant],
                [$instant, null, $privacy, $instant],
                [null, $consent, $privacy, $instant],
                [$instant, null, $privacy, null],
                [$instant, null, null, $instant],
                [null, null, $privacy, null],
                [null, null, null, $instant],
                [null, $consent, null, null],
                [null, null, null, null],
            ];
            foreach ($refused as $index => [$consentAt, $consentNotice, $privacyId, $presentedAt]) {
                $reference = 'BADR-QR' . ['AB', 'CD', 'EF', 'GH', 'JK', 'LM', 'NP', 'ST', 'UV'][$index];
                $this->expectConstraintFailure(fn () => $this->seedBasisEvidenceBooking(
                    $reference,
                    $consentAt,
                    $consentNotice,
                    $privacyId,
                    $presentedAt,
                ));
            }

            // And 0021 stays repeat-safe on re-run: the exclusive clause remains.
            self::assertSame([], $this->migrator($directory)->migrate());
            self::assertStringContainsString(
                'consent_notice_id',
                (string) $this->checkClause('bookings', 'chk_bookings_basis_evidence'),
            );
        } finally {
            TestEnvironment::removeDirectory($directory);
        }
    }

    /** A booking row with every ESZ-142/ESZ-161 basis-evidence column stated explicitly. */
    private function seedBasisEvidenceBooking(
        string $reference,
        ?string $consentAt,
        ?string $consentNoticeId,
        ?string $privacyNoticeId,
        ?string $presentedAt,
    ): void {
        $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, consent_at_utc, consent_notice_id,'
            . ' privacy_notice_id, privacy_notice_presented_at_utc,'
            . ' created_at, updated_at, state_changed_at)'
            . " VALUES (:reference, 'lips', 'confirmed',"
            . " '2026-06-15 10:00:00.000', '2026-06-15 11:00:00.000', 'Europe/Paris',"
            . " 'Cliente', 'cliente@example.test', :consentAt, :consentNotice, :notice, :presented,"
            . ' :created, :updated, :changed)',
            [
                'reference' => $reference,
                'consentAt' => $consentAt,
                'consentNotice' => $consentNoticeId,
                'notice' => $privacyNoticeId,
                'presented' => $presentedAt,
                'created' => self::NOW,
                'updated' => self::NOW,
                'changed' => self::NOW,
            ],
        );
    }

    /**
     * A booking row of the ESZ-161 shape: no consent instant, a privacy
     * notice id and its presentation instant stated explicitly.
     */
    private function seedPrivacyBooking(
        string $reference,
        ?string $noticeId,
        ?string $presentedAt = '2026-06-13 09:00:00.000',
    ): void {
        $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, privacy_notice_id, privacy_notice_presented_at_utc,'
            . ' created_at, updated_at, state_changed_at)'
            . " VALUES (:reference, 'lips', 'confirmed',"
            . " '2026-06-15 10:00:00.000', '2026-06-15 11:00:00.000', 'Europe/Paris',"
            . " 'Cliente', 'cliente@example.test', :notice, :presented,"
            . ' :created, :updated, :changed)',
            [
                'reference' => $reference,
                'notice' => $noticeId,
                'presented' => $presentedAt,
                'created' => self::NOW,
                'updated' => self::NOW,
                'changed' => self::NOW,
            ],
        );
    }

    // --- ESZ-131: the lifecycle marker column ------------------------------

    /**
     * Migration 0015 adds the nullable lifecycle marker to notification_jobs:
     * a BIGINT UNSIGNED that names the booking_history event a lifecycle job
     * belongs to. Existing rows predating the marker keep a NULL (never an
     * invented one), reminders carry none by construction, and the marker
     * stays repeat-safe on re-run.
     */
    public function testMigration0015AddsTheNullableLifecycleMarkerColumn(): void
    {
        $this->migrator()->migrate();

        $column = $this->column('notification_jobs', 'lifecycle_event_id');
        self::assertSame('bigint', $column['DATA_TYPE']);
        self::assertSame('YES', $column['IS_NULLABLE']);

        // A pre-0015-style row (no marker column stated) lands with NULL, and a
        // real lifecycle marker round-trips.
        $bookingId = $this->seedBookingForNotifications();
        $this->insertJob($bookingId, []);
        $legacy = $this->database->fetchOne(
            'SELECT lifecycle_event_id FROM notification_jobs WHERE booking_id = :booking',
            ['booking' => $bookingId],
        );
        self::assertNull($legacy['lifecycle_event_id'] ?? null, 'a pre-marker row invented a lifecycle event');

        $this->database->run(
            'UPDATE notification_jobs SET lifecycle_event_id = :event WHERE booking_id = :booking',
            ['event' => 41, 'booking' => $bookingId],
        );
        $updated = $this->database->fetchOne(
            'SELECT lifecycle_event_id FROM notification_jobs WHERE booking_id = :booking',
            ['booking' => $bookingId],
        );
        self::assertSame(41, $updated['lifecycle_event_id'] ?? null);
    }

    // --- ESZ-149: the catalog's editorial columns --------------------------

    /**
     * Migration 0016 turns booking_services into the administrable catalog:
     * a NOT NULL description defaulting to empty (an old row gains nothing
     * fabricated), a nullable ascii_bin image_src bounded by a CHECK to the
     * managed media path shape, and every guard repeat-safe.
     */
    public function testMigration0016AddsTheCatalogColumnsWithoutTouchingExistingRows(): void
    {
        $this->migrator()->migrate();

        $description = $this->column('booking_services', 'description');
        self::assertSame('varchar', $description['DATA_TYPE']);
        self::assertSame('NO', $description['IS_NULLABLE']);
        self::assertSame(2000, (int) $this->database->fetchOne(
            'SELECT CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.columns'
            . " WHERE table_schema = DATABASE() AND table_name = 'booking_services' AND column_name = 'description'",
        )['n']);
        $image = $this->column('booking_services', 'image_src');
        self::assertSame('YES', $image['IS_NULLABLE']);
        self::assertSame('ascii_bin', $image['COLLATION_NAME']);
        $check = $this->checkClause('booking_services', 'chk_booking_services_image_src');
        self::assertNotNull($check);
        self::assertStringContainsString('is null', (string) $check);
        self::assertStringContainsString('regexp_like', (string) $check);

        // A pre-0016-style insert (neither column stated) lands with an empty
        // description and no image: nothing is invented for an old row.
        $this->database->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at)'
            . " VALUES ('brows', 'Sourcils', 60, 0, 0, 1, :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        );
        $legacy = $this->database->fetchOne(
            "SELECT description, image_src FROM booking_services WHERE service_key = 'brows'",
        );
        self::assertIsArray($legacy);
        self::assertSame('', $legacy['description']);
        self::assertArrayHasKey('image_src', $legacy);
        self::assertNull($legacy['image_src']);

        // A managed path round-trips…
        $managed = '/media/med_' . str_repeat('a', 32) . '.webp';
        $this->database->run(
            "UPDATE booking_services SET image_src = :src WHERE service_key = 'brows'",
            ['src' => $managed],
        );
        self::assertSame($managed, $this->database->fetchOne(
            "SELECT image_src FROM booking_services WHERE service_key = 'brows'",
        )['image_src'] ?? null);

        // …and an arbitrary path, an external URL and a wrong extension are
        // refused by the schema itself.
        foreach (['/etc/passwd', 'https://example.test/p.jpg', '/media/med_' . str_repeat('a', 32) . '.gif'] as $bad) {
            $this->expectConstraintFailure(fn () => $this->database->run(
                "UPDATE booking_services SET image_src = :src WHERE service_key = 'brows'",
                ['src' => $bad],
            ));
        }

        // Repeat-safe: re-running the migrator applies nothing and changes
        // nothing.
        self::assertSame([], $this->migrator()->migrate());
        self::assertSame($managed, $this->database->fetchOne(
            "SELECT image_src FROM booking_services WHERE service_key = 'brows'",
        )['image_src'] ?? null);
    }

    // --- ESZ-150: validated combinations, additive on bookings ------------

    /**
     * ESZ-152 — migration 0018 adds the additive `availability_constraints`
     * table: MySQL itself ties the enforcement to the kind, requires a window
     * on the timed kinds and refuses one on the all-day kinds, and refuses an
     * inverted date range. `availability_exceptions` is untouched.
     */
    public function testMigration0018AddsPlanningConstraintsWithTheirShapeChecks(): void
    {
        $this->migrator()->migrate();

        self::assertSame('ascii_bin', $this->column('availability_constraints', 'enforcement')['COLLATION_NAME']);
        self::assertSame('YES', $this->column('availability_constraints', 'start_local')['IS_NULLABLE']);
        self::assertSame('uq_availability_exceptions_date', $this->database->fetchOne(
            'SELECT constraint_name AS n FROM information_schema.table_constraints'
            . " WHERE table_schema = DATABASE() AND table_name = 'availability_exceptions'"
            . " AND constraint_type = 'UNIQUE'",
        )['n'] ?? null);

        $insert = fn (string $kind, string $enforcement, string $from, string $until, ?string $start, ?string $end) =>
            $this->database->run(
                'INSERT INTO availability_constraints (constraint_kind, enforcement, start_date, end_date,'
                . ' start_local, end_local, created_at, updated_at)'
                . ' VALUES (:kind, :enforcement, :from, :until, :start, :end, :created, :updated)',
                [
                    'kind' => $kind, 'enforcement' => $enforcement, 'from' => $from, 'until' => $until,
                    'start' => $start, 'end' => $end, 'created' => self::NOW, 'updated' => self::NOW,
                ],
            );

        $insert('pause', 'flexible', '2026-08-18', '2026-08-18', '12:30:00', '13:30:00');
        $insert('unavailability', 'strict', '2026-08-18', '2026-08-18', '09:00:00', '11:00:00');
        $insert('closure', 'strict', '2026-08-24', '2026-08-25', null, null);
        $insert('leave', 'strict', '2026-08-03', '2026-08-16', null, null);
        self::assertSame(
            4,
            (int) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM availability_constraints')['n'] ?? 0),
        );

        // A pause can only be flexible and a blocker only strict; a timed kind
        // needs its window on one date and an all-day kind refuses one; an
        // inverted range is refused.
        foreach (
            [
                ['pause', 'strict', '2026-08-18', '2026-08-18', '12:30:00', '13:30:00'],
                ['leave', 'flexible', '2026-08-03', '2026-08-16', null, null],
                ['unavailability', 'strict', '2026-08-18', '2026-08-18', null, null],
                ['unavailability', 'strict', '2026-08-18', '2026-08-19', '09:00:00', '11:00:00'],
                ['pause', 'flexible', '2026-08-18', '2026-08-18', '13:30:00', '12:30:00'],
                ['closure', 'strict', '2026-08-24', '2026-08-24', '09:00:00', '11:00:00'],
                ['leave', 'strict', '2026-08-16', '2026-08-03', null, null],
            ] as $refused
        ) {
            $this->expectConstraintFailure(fn () => $insert(...$refused));
        }
    }

    /**
     * Migration 0017 adds the combination table and a nullable
     * `bookings.combination_key` with a RESTRICT foreign key. An existing
     * booking row is untouched (null combination, same service key, start and
     * end), the key CHECK admits only the canonical sorted-and-joined shape,
     * and every guard is repeat-safe.
     */
    public function testMigration0017AddsCombinationsWithoutTouchingExistingBookings(): void
    {
        $this->migrator()->migrate();

        $column = $this->column('bookings', 'combination_key');
        self::assertSame('YES', $column['IS_NULLABLE']);
        self::assertSame('ascii_bin', $column['COLLATION_NAME']);
        self::assertSame('fk_bookings_combination', $this->database->fetchOne(
            'SELECT constraint_name AS n FROM information_schema.table_constraints'
            . " WHERE table_schema = DATABASE() AND table_name = 'bookings'"
            . " AND constraint_type = 'FOREIGN KEY' AND constraint_name = 'fk_bookings_combination'",
        )['n'] ?? null);

        // A pre-0017-style booking lands with a null combination and keeps
        // its stored facts: nothing recalculates it.
        $this->database->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, duration_minutes, is_active, created_at, updated_at)'
            . " VALUES ('brows', 'Sourcils', 60, 1, :created, :updated),"
            . " ('lips', 'Lèvres', 90, 1, :created2, :updated2)",
            ['created' => self::NOW, 'updated' => self::NOW, 'created2' => self::NOW, 'updated2' => self::NOW],
        );
        $this->database->run(
            'INSERT INTO bookings (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, consent_at_utc, created_at, updated_at, state_changed_at)'
            . " VALUES ('bk_" . str_repeat('a', 32) . "', 'brows', 'confirmed', '2026-06-15 07:00:00.000',"
            . " '2026-06-15 08:00:00.000', 'Europe/Paris', 'Cliente', 'c@example.test', '2026-06-13 12:00:00.000',"
            . ' :created, :updated, :changed)',
            ['created' => self::NOW, 'updated' => self::NOW, 'changed' => self::NOW],
        );
        $legacy = $this->database->fetchOne(
            'SELECT service_key, combination_key, starts_at_utc, ends_at_utc FROM bookings',
        );
        self::assertIsArray($legacy);
        self::assertSame('brows', $legacy['service_key']);
        self::assertNull($legacy['combination_key']);
        self::assertSame('2026-06-15 07:00:00.000', $legacy['starts_at_utc']);
        self::assertSame('2026-06-15 08:00:00.000', $legacy['ends_at_utc']);

        // The combination key must be the canonical shape, and a booking
        // may only name a stored combination.
        $this->database->run(
            'INSERT INTO booking_service_combinations (combination_key, proposed_duration_minutes,'
            . " duration_minutes, created_at, updated_at) VALUES ('brows+lips', 150, 120, :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        );
        $this->expectConstraintFailure(fn () => $this->database->run(
            'INSERT INTO booking_service_combinations (combination_key, proposed_duration_minutes,'
            . " duration_minutes, created_at, updated_at) VALUES ('brows', 60, 60, :created, :updated)",
            ['created' => self::NOW, 'updated' => self::NOW],
        ));
        $this->expectConstraintFailure(fn () => $this->database->run(
            "UPDATE bookings SET combination_key = 'lips+brows'",
        ));
        $this->database->run("UPDATE bookings SET combination_key = 'brows+lips'");
        $this->expectConstraintFailure(fn () => $this->database->run(
            "DELETE FROM booking_service_combinations WHERE combination_key = 'brows+lips'",
        ));

        // Repeat-safe: re-running the migrator applies nothing and changes
        // nothing.
        self::assertSame([], $this->migrator()->migrate());
        self::assertSame('brows+lips', $this->database->fetchOne(
            'SELECT combination_key FROM bookings',
        )['combination_key'] ?? null);
    }

    /**
     * A booking row whose consent notice id is stated explicitly.
     */
    private function seedBookingWithNotice(string $reference, string $noticeId): void
    {
        $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, consent_at_utc, consent_notice_id,'
            . ' created_at, updated_at, state_changed_at)'
            . " VALUES (:reference, 'lips', 'confirmed',"
            . " '2026-06-15 10:00:00.000', '2026-06-15 11:00:00.000', 'Europe/Paris',"
            . " 'Cliente', 'cliente@example.test', '2026-06-13 09:00:00.000', :notice,"
            . ' :created, :updated, :changed)',
            [
                'reference' => $reference,
                'notice' => $noticeId,
                'created' => self::NOW,
                'updated' => self::NOW,
                'changed' => self::NOW,
            ],
        );
    }

    // --- ESZ-153: booking-owned buffer snapshots ---------------------------

    /**
     * ESZ-153 — migration 0019 adds `booking_buffer_snapshots` and freezes
     * every pre-existing booking, once, to the buffers authoritative for it
     * at that instant: its combination's when it names one, its service's
     * otherwise. Nothing on `bookings` is rewritten, a later catalog edit
     * leaves the frozen row alone, and a re-run inserts nothing.
     */
    public function testMigration0019FreezesLegacyBookingsToTheirCurrentEffectiveBuffers(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-migrations-esz153');

        try {
            $migrations = TestDatabase::migrationsDirectory();
            foreach ((glob($migrations . '/000[1-9]_*.sql') ?: []) as $file) {
                copy($file, $directory . '/' . basename($file));
            }
            foreach ((glob($migrations . '/001[0-8]_*.sql') ?: []) as $file) {
                copy($file, $directory . '/' . basename($file));
            }

            // The pre-0019 world: a single-service booking with the service's
            // buffers and a combination booking with the combination's.
            self::assertCount(18, $this->migrator($directory)->migrate());
            foreach ([['brows', 30, 5, 0], ['lips', 60, 0, 10]] as [$key, $duration, $before, $after]) {
                $this->database->run(
                    'INSERT INTO booking_services'
                    . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
                    . ' buffer_after_minutes, is_active, created_at, updated_at)'
                    . ' VALUES (:key, :label, :duration, :before, :after, 1, :created, :updated)',
                    [
                        'key' => $key, 'label' => $key, 'duration' => $duration, 'before' => $before, 'after' => $after,
                        'created' => self::NOW, 'updated' => self::NOW,
                    ],
                );
            }
            $this->database->run(
                'INSERT INTO booking_service_combinations (combination_key, proposed_duration_minutes,'
                . ' duration_minutes, buffer_before_minutes, buffer_after_minutes, is_active, created_at, updated_at)'
                . " VALUES ('brows+lips', 90, 75, 15, 20, 1, :created, :updated)",
                ['created' => self::NOW, 'updated' => self::NOW],
            );
            $insertBooking = fn (string $reference, string $service, ?string $combination, string $end) =>
                $this->database->run(
                    'INSERT INTO bookings'
                    . ' (reference, service_key, combination_key, state, starts_at_utc, ends_at_utc, timezone_name,'
                    . ' customer_name, customer_email, consent_at_utc, created_at, updated_at, state_changed_at)'
                    . " VALUES (:reference, :service, :combination, 'confirmed',"
                    . " '2026-06-15 10:00:00.000', :end, 'Europe/Paris',"
                    . " 'Cliente', 'cliente@example.test', '2026-06-13 09:00:00.000', :created, :updated, :changed)",
                    [
                        'reference' => $reference, 'service' => $service, 'combination' => $combination,
                        'end' => $end, 'created' => self::NOW, 'updated' => self::NOW, 'changed' => self::NOW,
                    ],
                );
            $insertBooking('bk_99999999999999999999999999999991', 'brows', null, '2026-06-15 10:30:00.000');
            $insertBooking('bk_99999999999999999999999999999992', 'brows', 'brows+lips', '2026-06-15 11:15:00.000');
            $before = $this->database->fetchAll('SELECT * FROM bookings ORDER BY id');

            // The deploy: 0019 lands and applies alone.
            copy($migrations . '/0019_booking_buffer_snapshots.sql', $directory . '/0019_booking_buffer_snapshots.sql');
            self::assertSame(['0019'], $this->migrator($directory)->migrate());

            self::assertSame($before, $this->database->fetchAll('SELECT * FROM bookings ORDER BY id'));
            $frozen = fn (): array => $this->database->fetchAll(
                'SELECT b.reference, ss.buffer_before_minutes AS before_m,'
                . ' ss.buffer_after_minutes AS after_m, ss.origin'
                . ' FROM booking_buffer_snapshots ss INNER JOIN bookings b ON b.id = ss.booking_id ORDER BY b.id',
            );
            $expected = [
                [
                    'reference' => 'bk_99999999999999999999999999999991',
                    'before_m' => 5, 'after_m' => 0, 'origin' => 'legacy',
                ],
                [
                    'reference' => 'bk_99999999999999999999999999999992',
                    'before_m' => 15, 'after_m' => 20, 'origin' => 'legacy',
                ],
            ];
            self::assertSame($expected, $frozen());
            $frozenAt = $this->database->fetchOne(
                'SELECT frozen_at FROM booking_buffer_snapshots LIMIT 1',
            )['frozen_at'] ?? null;
            self::assertIsString($frozenAt);
            self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $frozenAt);

            // A catalog edit after the freeze changes nothing frozen, and the
            // migration stays repeat-safe.
            $this->database->run("UPDATE booking_services SET buffer_before_minutes = 60 WHERE service_key = 'brows'");
            $this->database->run(
                "UPDATE booking_service_combinations SET buffer_after_minutes = 0 WHERE combination_key = 'brows+lips'",
            );
            self::assertSame([], $this->migrator($directory)->migrate());
            self::assertSame($expected, $frozen());

            // The schema refuses a second snapshot for a booking, a buffer
            // above the ceiling and an unknown origin.
            foreach (
                [
                    'INSERT INTO booking_buffer_snapshots VALUES (1, 0, 0, \'offer\', :now)',
                    'INSERT INTO booking_buffer_snapshots VALUES (3, 241, 0, \'offer\', :now)',
                    'INSERT INTO booking_buffer_snapshots VALUES (3, 0, 0, \'guess\', :now)',
                ] as $bad
            ) {
                $this->expectConstraintFailure(fn () => $this->database->run($bad, ['now' => self::NOW]));
            }
        } finally {
            TestEnvironment::removeDirectory($directory);
        }
    }

    // --- helpers -----------------------------------------------------------

    private function migrator(?string $directory = null): Migrator
    {
        return TestDatabase::migrator($this->database, new FrozenClock(self::NOW), $directory);
    }

    /** A minimal confirmed booking, so notification rows have something to reference. */
    private function seedBookingForNotifications(): int
    {
        $this->database->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at)'
            . " VALUES ('lips', 'Lèvres', 60, 0, 0, 1, :created, :updated)"
            . ' ON DUPLICATE KEY UPDATE booking_label = VALUES(booking_label)',
            ['created' => self::NOW, 'updated' => self::NOW],
        );

        $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, consent_at_utc, created_at, updated_at, state_changed_at)'
            . " VALUES ('bk_33333333333333333333333333333333', 'lips', 'confirmed',"
            . " '2026-06-15 10:00:00.000', '2026-06-15 11:00:00.000', 'Europe/Paris',"
            . " 'Cliente', 'cliente@example.test', '2026-06-13 09:00:00.000', :created, :updated, :changed)",
            ['created' => self::NOW, 'updated' => self::NOW, 'changed' => self::NOW],
        );

        return (int) $this->database->pdo()->lastInsertId();
    }

    /**
     * Inserts one notification row with every column stated, so a test names only
     * the field it is about.
     *
     * @param array<string, string|int|null> $overrides
     */
    private function insertJob(int $bookingId, array $overrides): void
    {
        $row = [
            'key' => 'default.email.confirmation',
            'channel' => 'email',
            'type' => 'booking_confirmation',
            'due' => '2026-06-15 08:00:00.000',
            'next' => '2026-06-15 08:00:00.000',
            'status' => 'pending',
            'attempts' => 0,
            'error' => null,
            'sent_at' => null,
            'lease_owner' => null,
            'lease_expires' => null,
        ];

        foreach ($overrides as $field => $value) {
            $row[$field] = $value;
        }

        $this->database->run(
            'INSERT INTO notification_jobs ('
            . ' idempotency_key, booking_id, channel, job_type, due_at_utc, next_attempt_at_utc,'
            . ' status, attempts, last_error_code, sent_at_utc, lease_owner, lease_expires_at_utc,'
            . ' created_at, updated_at, status_changed_at'
            . ') VALUES ('
            . ' :key, :booking, :channel, :type, :due, :next, :status, :attempts, :error,'
            . ' :sentAt, :leaseOwner, :leaseExpires, :created, :updated, :changed)',
            [
                'key' => $row['key'],
                'booking' => $bookingId,
                'channel' => $row['channel'],
                'type' => $row['type'],
                'due' => $row['due'],
                'next' => $row['next'],
                'status' => $row['status'],
                'attempts' => $row['attempts'],
                'error' => $row['error'],
                'sentAt' => $row['sent_at'],
                'leaseOwner' => $row['lease_owner'],
                'leaseExpires' => $row['lease_expires'],
                'created' => self::NOW,
                'updated' => self::NOW,
                'changed' => self::NOW,
            ],
        );
    }

    /** @return array<string, mixed> */
    private function column(string $table, string $column): array
    {
        return $this->database->fetchOne(
            'SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE'
            . ' FROM information_schema.COLUMNS'
            . ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c',
            ['t' => $table, 'c' => $column],
        ) ?? [];
    }

    /** @param \Closure(): mixed $operation */
    private function expectConstraintFailure(\Closure $operation): void
    {
        try {
            $operation();
            self::fail('MySQL accepted a row that violates a Package 4.1 constraint.');
        } catch (DatabaseException $exception) {
            self::assertSame('A database statement failed.', $exception->getMessage());
        }
    }

    // --- ESZ-084: rate_limit_buckets --------------------------------------

    /**
     * The limiter's table, and the two constraints that make it safe.
     *
     * The schema is the limiter's correctness, not a container for it: the key is
     * a hash so the table holds nobody's address, and the expiry CHECK is what
     * stops a row being swept while it is still refusing someone — which is the
     * one way this table could hand out allowance it had already spent.
     */
    public function testTheRateLimitTableStoresAHashAndNeverAnIdentity(): void
    {
        $this->migrator()->migrate();

        $columns = [];
        foreach ($this->database->fetchAll('SHOW COLUMNS FROM rate_limit_buckets') as $column) {
            $columns[(string) $column['Field']] = strtolower((string) $column['Type']);
        }

        self::assertSame(
            ['bucket_key', 'scope', 'tat_ms', 'expires_at_ms'],
            array_keys($columns),
        );

        // BINARY(32): a raw sha256, compared byte-exactly. Hex would double the
        // index, and a text collation could make two different buckets share a row.
        self::assertSame('binary(32)', $columns['bucket_key']);

        // Numbers, not the VARCHAR timestamps the rest of this schema uses,
        // because these two are compared arithmetically rather than for equality.
        self::assertStringStartsWith('bigint', $columns['tat_ms']);
        self::assertStringStartsWith('bigint', $columns['expires_at_ms']);
    }

    public function testARateLimitRowCannotExpireBeforeItStopsRefusing(): void
    {
        $this->migrator()->migrate();

        $this->expectException(DatabaseException::class);

        $this->database->run(
            'INSERT INTO rate_limit_buckets (bucket_key, scope, tat_ms, expires_at_ms)'
            . ' VALUES (:key, :scope, 2000, 1000)',
            ['key' => hash('sha256', 'expiry', true), 'scope' => 'auth.login.address'],
        );
    }

    public function testARateLimitRowCannotCarryAScopeOutsideTheFrozenShape(): void
    {
        $this->migrator()->migrate();

        $this->expectException(DatabaseException::class);

        // A NUL in a scope would make the hashed key ambiguous, so the CHECK
        // constrains the shape rather than trusting the caller.
        $this->database->run(
            'INSERT INTO rate_limit_buckets (bucket_key, scope, tat_ms, expires_at_ms)'
            . ' VALUES (:key, :scope, 1000, 2000)',
            ['key' => hash('sha256', 'scope', true), 'scope' => 'Not A Valid Scope'],
        );
    }

    public function testTheRateLimitKeyIsUniquePerBucket(): void
    {
        $this->migrator()->migrate();

        $key = hash('sha256', 'unique', true);
        $insert = 'INSERT INTO rate_limit_buckets (bucket_key, scope, tat_ms, expires_at_ms)'
            . ' VALUES (:key, :scope, 1000, 2000)';

        $this->database->run($insert, ['key' => $key, 'scope' => 'auth.login.address']);

        $this->expectException(DatabaseException::class);
        $this->database->run($insert, ['key' => $key, 'scope' => 'auth.login.address']);
    }

    // --- ESZ-140: customer-data retention schema ---------------------------

    /**
     * Migration 0011 must be as repeat-safe as every other one: DDL commits
     * implicitly on MySQL, so a crash after the first guarded ALTER but before
     * the registry insert leaves 0011 pending. Re-running it must complete on
     * the parts that already succeeded instead of failing on them.
     */
    public function testMigration0011CompletesWhenRerunAfterAPartialApplication(): void
    {
        $this->migrator()->migrate();

        // Exactly the state such a crash leaves: the DDL applied, the registry
        // row missing.
        $this->database->run(
            'DELETE FROM ' . Migrator::TABLE . ' WHERE version = :version',
            ['version' => '0011'],
        );

        self::assertSame(['0011'], $this->migrator()->migrate());
        self::assertSame([], $this->migrator()->pendingVersions());

        // The guarded forms must have been no-ops, not duplicates.
        $markers = $this->database->fetchAll(
            'SELECT COUNT(*) AS total FROM information_schema.columns'
            . ' WHERE table_schema = DATABASE() AND table_name = :t AND column_name = :c',
            ['t' => 'bookings', 'c' => 'customer_data_erased_at'],
        );
        self::assertSame(1, (int) $markers[0]['total']);
    }

    /**
     * Migration 0012 is one guarded ADD KEY, and it obeys the same repeat-safe
     * rule: a crash between the DDL and the registry insert leaves the index
     * in place with 0012 pending, and re-running must be a no-op rather than a
     * duplicate-index failure.
     */
    public function testMigration0012CompletesWhenRerunAfterAPartialApplication(): void
    {
        $this->migrator()->migrate();

        $this->database->run(
            'DELETE FROM ' . Migrator::TABLE . ' WHERE version = :version',
            ['version' => '0012'],
        );

        self::assertSame(['0012'], $this->migrator()->migrate());
        self::assertSame([], $this->migrator()->pendingVersions());

        $indexes = $this->database->fetchAll(
            'SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.statistics'
            . ' WHERE table_schema = DATABASE() AND table_name = :t AND index_name = :i'
            . ' ORDER BY SEQ_IN_INDEX',
            ['t' => 'bookings', 'i' => 'ix_bookings_starts_reference'],
        );
        self::assertSame(
            [
                ['INDEX_NAME' => 'ix_bookings_starts_reference', 'SEQ_IN_INDEX' => 1, 'COLUMN_NAME' => 'starts_at_utc'],
                ['INDEX_NAME' => 'ix_bookings_starts_reference', 'SEQ_IN_INDEX' => 2, 'COLUMN_NAME' => 'reference'],
            ],
            $indexes,
            'the keyset index must cover exactly (starts_at_utc, reference)',
        );
    }

    /**
     * Migration 0013 is one guarded ADD KEY, and it obeys the same repeat-safe
     * rule: a crash between the DDL and the registry insert leaves the index in
     * place with 0013 pending, and re-running must be a no-op rather than a
     * duplicate-index failure.
     */
    public function testMigration0013CompletesWhenRerunAfterAPartialApplication(): void
    {
        $this->migrator()->migrate();

        $this->database->run(
            'DELETE FROM ' . Migrator::TABLE . ' WHERE version = :version',
            ['version' => '0013'],
        );

        self::assertSame(['0013'], $this->migrator()->migrate());
        self::assertSame([], $this->migrator()->pendingVersions());

        $indexes = $this->database->fetchAll(
            'SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.statistics'
            . ' WHERE table_schema = DATABASE() AND table_name = :t AND index_name = :i'
            . ' ORDER BY SEQ_IN_INDEX',
            ['t' => 'admin_sessions', 'i' => 'ix_admin_sessions_absolute_expires_at'],
        );
        self::assertSame(
            [
                [
                    'INDEX_NAME' => 'ix_admin_sessions_absolute_expires_at',
                    'SEQ_IN_INDEX' => 1,
                    'COLUMN_NAME' => 'absolute_expires_at',
                ],
            ],
            $indexes,
            'the GC index must cover exactly absolute_expires_at',
        );
    }

    /**
     * The ESZ-130 GC index is what makes each pass of the session sweep an
     * index-range delete: each bounded DELETE filters and orders on the same
     * column, so MySQL answers it through that column's index. The idle index
     * has existed since 0002; the absolute one is added by 0013. Read from
     * information_schema and EXPLAIN so the assertion is about what MySQL
     * actually uses, not about a migration text.
     */
    public function testTheSessionSweepIsAnswerableThroughBothDeadlineIndexes(): void
    {
        $this->migrator()->migrate();

        foreach (
            [
                'ix_admin_sessions_expires_at' => 'expires_at',
                'ix_admin_sessions_absolute_expires_at' => 'absolute_expires_at',
            ] as $index => $column
        ) {
            $found = $this->database->fetchAll(
                'SELECT INDEX_NAME FROM information_schema.statistics'
                . ' WHERE table_schema = DATABASE() AND table_name = :t AND index_name = :i',
                ['t' => 'admin_sessions', 'i' => $index],
            );
            self::assertCount(1, $found, "the {$index} index is missing after the migrations");

            $explain = $this->database->fetchAll(
                'EXPLAIN SELECT id FROM admin_sessions'
                . ' WHERE ' . $column . ' <= :now ORDER BY ' . $column . ' LIMIT 200',
                ['now' => '2026-06-13T12:00:00.000Z'],
            );
            $row = $explain[0] ?? [];
            self::assertSame(
                $index,
                $row['key'] ?? null,
                "the {$column} sweep pass must be answered through its own index",
            );
            self::assertContains(
                $row['type'] ?? null,
                ['range', 'index'],
                "the {$column} sweep pass must not be a table scan",
            );
            self::assertStringNotContainsString('filesort', (string) ($row['Extra'] ?? ''));
        }
    }

    /**
     * The keyset pagination index is what makes an ESZ-144 range page an
     * index-range read: the probe query filters and orders on the same leading
     * columns. Read from information_schema so the assertion is about what
     * MySQL actually uses, not about a migration text.
     */
    public function testTheKeysetPaginationIndexMatchesTheRangeProbeQuery(): void
    {
        $this->migrator()->migrate();

        $explain = $this->database->fetchAll(
            'EXPLAIN SELECT id FROM bookings'
            . ' WHERE starts_at_utc >= :from_utc AND starts_at_utc < :until_utc'
            . ' ORDER BY starts_at_utc, reference LIMIT 201',
            [
                'from_utc' => '2026-06-01 00:00:00.000',
                'until_utc' => '2026-08-01 00:00:00.000',
            ],
        );
        $row = $explain[0] ?? [];
        $type = $row['type'] ?? null;
        self::assertSame(
            'ix_bookings_starts_reference',
            $row['key'] ?? null,
            'the range page must be answered through the keyset index',
        );
        // On an empty table the planner's cheapest index access is a full index
        // walk (`index`); on a busy one it narrows to `range`. What must never
        // happen is `ALL` (a table scan) — and the index also pays for the
        // ORDER BY, so there is no filesort either.
        self::assertContains($type, ['range', 'index'], 'the range page must not be a table scan');
        self::assertStringNotContainsString('filesort', (string) ($row['Extra'] ?? ''));
    }

    /**
     * The retention schema is the policy written where SQL can enforce it:
     * the erasure column exists and is nullable, the erasure CHECK restates the
     * frozen placeholders, and the notification status CHECK admits exactly the
     * frozen statuses. Read from `information_schema` so the assertion is about
     * what MySQL actually enforces, not about a migration text.
     */
    public function testTheRetentionSchemaAgreesWithTheBookingDomainArtifact(): void
    {
        $this->migrator()->migrate();

        $retentionPolicy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());
        $notificationPolicy = NotificationPolicy::fromArtifacts(TestEnvironment::artifacts());

        $marker = $this->column('bookings', 'customer_data_erased_at');
        self::assertSame('datetime', $marker['DATA_TYPE']);
        self::assertSame('YES', $marker['IS_NULLABLE']);

        $erasureCheck = $this->checkClause('bookings', 'chk_bookings_customer_data_erasure');
        self::assertNotNull($erasureCheck, 'the erasure CHECK constraint is missing');
        self::assertStringContainsString('`customer_data_erased_at` is null', $erasureCheck);
        self::assertStringContainsString($retentionPolicy->erasedCustomerName, $erasureCheck);
        self::assertStringContainsString($retentionPolicy->erasedCustomerEmail, $erasureCheck);
        self::assertStringContainsString('`customer_phone` is null', $erasureCheck);
        self::assertStringContainsString('`customer_note` is null', $erasureCheck);
        self::assertStringContainsString('`cancellation_reason` is null', $erasureCheck);

        $statusCheck = $this->checkClause('notification_jobs', 'chk_notification_jobs_status');
        self::assertNotNull($statusCheck, 'the notification status CHECK constraint is missing');
        foreach ($notificationPolicy->statuses as $status) {
            self::assertStringContainsString($status, $statusCheck, "status {$status} is not in the CHECK");
        }
        // A status that is not in the frozen set must not be enforceable either.
        self::assertStringNotContainsString('deleted', $statusCheck);
    }

    /**
     * The schema itself refuses to repopulate an erased booking: once the
     * marker is set, the only customer values the row may hold are the frozen
     * placeholders, and the database — not a review habit — is what says so.
     */
    public function testAnErasedBookingRowCannotBeRepopulatedAtTheSchemaLevel(): void
    {
        $this->migrator()->migrate();
        $policy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());

        $bookingId = $this->seedBookingForNotifications();
        $this->database->run(
            'UPDATE bookings SET customer_data_erased_at = :marker,'
            . ' customer_name = :name, customer_email = :email,'
            . ' customer_phone = NULL, customer_note = NULL, cancellation_reason = NULL'
            . ' WHERE id = :id',
            [
                'marker' => '2026-01-01 00:00:00.000',
                'name' => $policy->erasedCustomerName,
                'email' => $policy->erasedCustomerEmail,
                'id' => $bookingId,
            ],
        );

        // A real customer write to the erased row violates chk_bookings_customer_data_erasure.
        $this->expectException(DatabaseException::class);
        $this->database->run(
            'UPDATE bookings SET customer_name = :name, customer_phone = :phone WHERE id = :id',
            ['name' => 'Reintroduced', 'phone' => '+33 6 00 00 00 00', 'id' => $bookingId],
        );
    }

    /**
     * A `retired` notification row must satisfy every lease, sent-instant and
     * error-code constraint that applies to the other statuses: no dangling
     * lease, no sent instant, a code that matches the frozen pattern.
     */
    public function testARetiredNotificationJobSatisfiesTheTerminalConstraints(): void
    {
        $this->migrator()->migrate();
        $policy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());

        $bookingId = $this->seedBookingForNotifications();
        $this->database->run(
            'INSERT INTO notification_jobs ('
            . ' idempotency_key, booking_id, channel, job_type, due_at_utc, next_attempt_at_utc,'
            . ' status, attempts, last_error_code, sent_at_utc, lease_owner, lease_expires_at_utc,'
            . ' created_at, updated_at, status_changed_at'
            . ') VALUES ('
            . ' :key, :booking, :channel, :type, :due, :next, :status, 1, :code,'
            . ' NULL, NULL, NULL, :now, :now2, :now3)',
            [
                'key' => 'retired.example.confirmation',
                'booking' => $bookingId,
                'channel' => 'email',
                'type' => 'booking_confirmation',
                'due' => '2026-06-15 08:00:00.000',
                'next' => '2026-06-15 08:00:00.000',
                'status' => 'retired',
                'code' => $policy->erasureJobCode,
                'now' => self::NOW,
                'now2' => self::NOW,
                'now3' => self::NOW,
            ],
        );

        $stored = $this->database->fetchOne(
            'SELECT status, last_error_code, lease_owner, sent_at_utc FROM notification_jobs'
            . ' WHERE idempotency_key = :key',
            ['key' => 'retired.example.confirmation'],
        );
        self::assertSame('retired', $stored['status']);
        self::assertSame($policy->erasureJobCode, $stored['last_error_code']);
        self::assertNull($stored['lease_owner']);
        self::assertNull($stored['sent_at_utc']);
    }

    /** @return string|null */
    private function checkClause(string $table, string $constraint): ?string
    {
        $row = $this->database->fetchOne(
            'SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS'
            . ' WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = :name',
            ['name' => $constraint],
        );

        return \is_string($row['CHECK_CLAUSE'] ?? null) ? $row['CHECK_CLAUSE'] : null;
    }
}
