<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Database\Database;
use Eszter\Database\DatabaseException;
use Eszter\Database\Migrator;
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

        self::assertSame(['0001', '0002'], $applied);
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
        foreach (['admin_accounts', 'admin_sessions'] as $table) {
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
            ] as $table => $columns
        ) {
            foreach ($columns as $column) {
                self::assertNotSame([], $this->column($table, $column), "{$table}.{$column}");
            }
        }
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

    // --- helpers -----------------------------------------------------------

    private function migrator(?string $directory = null): Migrator
    {
        return TestDatabase::migrator($this->database, new FrozenClock(self::NOW), $directory);
    }

    /** @return array<string, mixed> */
    private function column(string $table, string $column): array
    {
        return $this->database->fetchOne(
            'SELECT COLUMN_NAME, DATA_TYPE, COLLATION_NAME, IS_NULLABLE'
            . ' FROM information_schema.COLUMNS'
            . ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c',
            ['t' => $table, 'c' => $column],
        ) ?? [];
    }
}
