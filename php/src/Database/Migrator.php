<?php

declare(strict_types=1);

namespace Eszter\Database;

use Eszter\Support\Clock;

/**
 * Ordered, forward-only, repeat-safe schema migrations (ESZ-023).
 *
 * `docs/hetzner-target-architecture.md` §8: "Every schema change is a numbered,
 * forward-only migration file, applied by a script, recorded in a
 * `schema_migrations` table. No hand-edited production schema, ever."
 *
 * ## Why every migration must be idempotent on its own
 *
 * MySQL commits implicitly before and after every DDL statement. A migration is
 * therefore *not* atomic and cannot be made atomic: a file with three
 * `CREATE TABLE`s that fails on the third leaves two tables behind and no row in
 * `schema_migrations`. Wrapping it in `BEGIN`/`COMMIT` would not change that; it
 * would only hide it behind syntax that looks like a guarantee.
 *
 * So the guarantee is moved into the files. Every statement must be written so
 * that running it twice is harmless — `CREATE TABLE IF NOT EXISTS`, and for later
 * changes `ALTER` guarded by an `information_schema` check — and re-running a
 * half-applied migration then completes it instead of failing on the part that
 * already succeeded. {@see assertIdempotentDdl()} enforces the rule mechanically
 * rather than trusting the next person to remember it, and
 * `MigrationRepeatabilityTest` proves it by migrating twice.
 *
 * ## Checksums
 *
 * Each applied migration's SHA-256 is recorded. An edit to a file that has
 * already run is a hard failure, because the database it was applied to is not
 * the database the edited file describes, and the difference would surface later
 * as an unexplainable schema drift on exactly one host.
 *
 * ## Concurrency
 *
 * Two deploys overlapping would race to create the same tables. A named advisory
 * lock serialises them; the second waits and then finds nothing pending. The lock
 * is MySQL-specific and simply skipped on other drivers, which are test-only.
 */
final class Migrator
{
    public const TABLE = 'schema_migrations';
    public const LOCK_NAME = 'eszter_schema_migrations';

    /**
     * How long a second deploy waits for the first to finish.
     *
     * Long enough that overlapping deploys serialise instead of one of them
     * failing, short enough that a stuck process is reported rather than hanging
     * the deploy indefinitely.
     */
    public const DEFAULT_LOCK_TIMEOUT_SECONDS = 30;

    /** Files must be `0001_name.sql`: a zero-padded ordinal, then a slug. */
    private const FILENAME_PATTERN = '/^(\d{4})_([a-z0-9_]+)\.sql$/';

    public function __construct(
        private readonly Database $database,
        private readonly string $directory,
        private readonly Clock $clock,
        /** Injectable so the contention test does not have to wait the real one out. */
        private readonly int $lockTimeoutSeconds = self::DEFAULT_LOCK_TIMEOUT_SECONDS,
    ) {
    }

    /**
     * Applies every pending migration in order and returns the versions applied.
     *
     * Running it against an already-current database applies nothing and returns
     * an empty list; that is the repeat-safety the gate asserts.
     *
     * @return list<string>
     */
    public function migrate(): array
    {
        return $this->database->withMutation(function (): array {
            $available = $this->available();
            $this->ensureRegistryTable();

            return $this->withLock(function () use ($available): array {
                $applied = $this->appliedRows();
                $this->assertNoAppliedMigrationWasEdited($available, $applied);
                $this->assertNoUnknownMigrationWasApplied($available, $applied);

                $newlyApplied = [];

                foreach ($available as $migration) {
                    if (self::checksumOf($applied, $migration['version']) !== null) {
                        continue;
                    }

                    $this->apply($migration);
                    $newlyApplied[] = $migration['version'];
                }

                return $newlyApplied;
            });
        });
    }

    /**
     * Versions recorded as applied, in order.
     *
     * @return list<string>
     */
    public function appliedVersions(): array
    {
        $this->ensureRegistryTable();

        return array_column($this->appliedRows(), 'version');
    }

    /**
     * Versions on disk that the database has not recorded.
     *
     * @return list<string>
     */
    public function pendingVersions(): array
    {
        $this->ensureRegistryTable();
        $applied = $this->appliedRows();
        $pending = [];

        foreach ($this->available() as $migration) {
            if (self::checksumOf($applied, $migration['version']) === null) {
                $pending[] = $migration['version'];
            }
        }

        return $pending;
    }

    /**
     * Reads schema compatibility without creating the registry table or applying
     * DDL. Restore preflight uses this so a refusal cannot migrate the target as a
     * side effect.
     *
     * @return array{applied: list<string>, pending: list<string>, registryExists: bool}
     */
    public function inspect(): array
    {
        $available = $this->available();
        $row = $this->database->fetchOne(
            'SELECT COUNT(*) AS total FROM information_schema.tables'
                . ' WHERE table_schema = DATABASE() AND table_name = :table',
            ['table' => self::TABLE],
        );
        $total = $row['total'] ?? null;
        if (!\is_int($total) && !(\is_string($total) && ctype_digit($total))) {
            throw DatabaseException::invariant('Could not determine whether the migration registry exists.');
        }
        $registryExists = (int) $total === 1;
        $applied = $registryExists ? $this->appliedRows() : [];

        $this->assertNoAppliedMigrationWasEdited($available, $applied);
        $this->assertNoUnknownMigrationWasApplied($available, $applied);

        $pending = [];
        foreach ($available as $migration) {
            if (self::checksumOf($applied, $migration['version']) === null) {
                $pending[] = $migration['version'];
            }
        }

        return [
            'applied' => array_column($applied, 'version'),
            'pending' => $pending,
            'registryExists' => $registryExists,
        ];
    }

    /**
     * The migration files, ordered by version.
     *
     * A list carrying an explicit `version` rather than a map keyed by it. PHP
     * silently converts a numeric string array key to an int — `"0001"` survives
     * because of its leading zero, but `"1234"` would not — so a map would change
     * the type of its own keys at migration 1000 and every `is_string` assumption
     * about them would quietly stop holding.
     *
     * @return list<array{version: string, name: string, path: string, sql: string, checksum: string}>
     */
    public function available(): array
    {
        if (!is_dir($this->directory)) {
            throw DatabaseException::invariant(
                'The migrations directory does not exist.',
                ['directory' => $this->directory],
            );
        }

        $entries = scandir($this->directory);

        if ($entries === false) {
            throw DatabaseException::invariant(
                'The migrations directory could not be read.',
                ['directory' => $this->directory],
            );
        }

        $migrations = [];

        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            if (preg_match(self::FILENAME_PATTERN, $entry, $match) !== 1) {
                // Not skipped: a file that is nearly a migration — `0007_x.SQL`,
                // `7_x.sql`, an editor's `.sql.bak` — would otherwise sort into
                // the wrong place or silently never run.
                throw DatabaseException::invariant(
                    'A file in the migrations directory is not named `NNNN_name.sql`.',
                    ['file' => $entry],
                );
            }

            $path = $this->directory . \DIRECTORY_SEPARATOR . $entry;
            $sql = file_get_contents($path);

            if ($sql === false) {
                throw DatabaseException::invariant('A migration file is unreadable.', ['file' => $entry]);
            }

            $version = $match[1];

            foreach ($migrations as $seen) {
                if ($seen['version'] === $version) {
                    throw DatabaseException::invariant(
                        'Two migration files share one version number.',
                        ['version' => $version],
                    );
                }
            }

            self::assertIdempotentDdl($entry, $sql);

            $migrations[] = [
                'version' => $version,
                'name' => $match[2],
                'path' => $path,
                'sql' => $sql,
                'checksum' => hash('sha256', $sql),
            ];
        }

        usort(
            $migrations,
            static fn (array $left, array $right): int => strcmp($left['version'], $right['version']),
        );

        return $migrations;
    }

    /**
     * Refuses a migration whose DDL is not safe to re-run.
     *
     * Checked at read time, so the failure happens on the developer's machine and
     * in the `sql:migrations` gate rather than half-way through a production
     * deploy. The rule is narrow on purpose — it recognises the guarded forms this
     * project actually uses, and anything else must be made obviously safe rather
     * than argued about at 2am.
     *
     * ESZ-112 extends the same stance to row-mutating DML. A migration that fails
     * part-way runs again, and no guard clause can make an UPDATE or a DELETE
     * mechanically verifiable as repeat-safe — the rows it affects can differ on
     * the second run, and REPLACE, TRUNCATE and RENAME have no guarded form at
     * all. They are therefore refused outright: only DML and DDL whose repetition
     * the migrator verifies mechanically (IF NOT EXISTS / IF EXISTS / INSERT
     * IGNORE / an information_schema guard) may appear in a migration, and no
     * comment or flag may waive that rule. Frozen migrations 0001–0015 contain
     * none of the refused statements, so the strengthened rule changes nothing
     * they do.
     */
    private static function assertIdempotentDdl(string $file, string $sql): void
    {
        foreach (self::statements($sql) as $statement) {
            $head = strtoupper(preg_replace('/\s+/', ' ', substr($statement, 0, 80)) ?? '');

            $isGuarded = str_starts_with($head, 'CREATE TABLE IF NOT EXISTS')
                || str_starts_with($head, 'CREATE INDEX IF NOT EXISTS')
                || str_starts_with($head, 'DROP TABLE IF EXISTS')
                || str_starts_with($head, 'DROP INDEX IF EXISTS')
                || str_starts_with($head, 'INSERT IGNORE')
                || str_starts_with($head, 'SET ');

            if ($isGuarded) {
                continue;
            }

            $isUnguardedDdl = str_starts_with($head, 'CREATE ')
                || str_starts_with($head, 'DROP ')
                || str_starts_with($head, 'ALTER ')
                || str_starts_with($head, 'INSERT ');

            if ($isUnguardedDdl) {
                throw DatabaseException::invariant(
                    'A migration statement is not safe to re-run. MySQL commits implicitly '
                    . 'around DDL, so a migration that fails part-way must be able to run again. '
                    . 'Use IF NOT EXISTS / IF EXISTS, or an information_schema guard.',
                    ['file' => $file, 'statement' => $head],
                );
            }

            $isUnverifiableMutation = str_starts_with($head, 'UPDATE ')
                || str_starts_with($head, 'DELETE ')
                || str_starts_with($head, 'REPLACE ')
                || str_starts_with($head, 'TRUNCATE ')
                || str_starts_with($head, 'RENAME ');

            if ($isUnverifiableMutation) {
                throw DatabaseException::invariant(
                    'A migration statement is refused because running it twice cannot be '
                    . 'verified mechanically safe. Migrations re-run after a partial '
                    . 'application, so they may contain only statements with a guarded form '
                    . 'the migrator recognises (IF NOT EXISTS / IF EXISTS / INSERT IGNORE / '
                    . 'an information_schema guard). UPDATE, DELETE, REPLACE, TRUNCATE and '
                    . 'RENAME have no such form, so each is refused before anything executes '
                    . '— and no comment or flag may waive the rule.',
                    ['file' => $file, 'statement' => $head],
                );
            }
        }
    }

    /**
     * Splits a migration file into statements.
     *
     * Line comments are stripped first so that a `--` line mentioning a semicolon
     * cannot split a statement in two. String literals are not parsed, because no
     * migration in this project contains a semicolon inside a literal and a
     * half-correct SQL lexer here would be a liability rather than a feature; if
     * one ever needs to, it must be split into its own file.
     *
     * @return list<string>
     */
    public static function statements(string $sql): array
    {
        $withoutComments = preg_replace('/^\s*--.*$/m', '', $sql) ?? $sql;

        $statements = [];
        foreach (explode(';', $withoutComments) as $part) {
            $trimmed = trim($part);
            if ($trimmed !== '') {
                $statements[] = $trimmed;
            }
        }

        return $statements;
    }

    /** @param array{version: string, name: string, path: string, sql: string, checksum: string} $migration */
    private function apply(array $migration): void
    {
        foreach (self::statements($migration['sql']) as $index => $statement) {
            $this->database->executeRaw($statement, \sprintf(
                'migration %s_%s statement %d',
                $migration['version'],
                $migration['name'],
                $index + 1,
            ));
        }

        // Recorded only after every statement succeeded. A crash between the last
        // statement and this insert leaves the migration pending and it runs
        // again, which the idempotence rule above makes harmless.
        $this->database->run(
            'INSERT INTO ' . self::TABLE . ' (version, name, checksum, applied_at)'
            . ' VALUES (:version, :name, :checksum, :applied_at)',
            [
                'version' => $migration['version'],
                'name' => $migration['name'],
                'checksum' => $migration['checksum'],
                'applied_at' => $this->clock->nowIso(),
            ],
        );
    }

    /**
     * @param list<array{version: string, name: string, path: string, sql: string, checksum: string}> $available
     * @param list<array{version: string, checksum: string}> $applied
     */
    private function assertNoAppliedMigrationWasEdited(array $available, array $applied): void
    {
        foreach ($available as $migration) {
            $checksum = self::checksumOf($applied, $migration['version']);

            if ($checksum !== null && !hash_equals($checksum, $migration['checksum'])) {
                throw DatabaseException::invariant(
                    'A migration that has already been applied was edited. Migrations are '
                    . 'forward-only: add a new one instead.',
                    ['version' => $migration['version']],
                );
            }
        }
    }

    /**
     * @param list<array{version: string, name: string, path: string, sql: string, checksum: string}> $available
     * @param list<array{version: string, checksum: string}> $applied
     */
    private function assertNoUnknownMigrationWasApplied(array $available, array $applied): void
    {
        $known = array_column($available, 'version');

        foreach ($applied as $row) {
            if (!\in_array($row['version'], $known, true)) {
                // The database is ahead of the code: almost always a deploy that
                // rolled the application back but not the schema. Continuing would
                // apply the *older* set of files onto a newer schema.
                throw DatabaseException::invariant(
                    'The database records a migration that this checkout does not contain. '
                    . 'The schema is ahead of the code.',
                    ['version' => $row['version']],
                );
            }
        }
    }

    /**
     * @param list<array{version: string, checksum: string}> $applied
     */
    private static function checksumOf(array $applied, string $version): ?string
    {
        foreach ($applied as $row) {
            if ($row['version'] === $version) {
                return $row['checksum'];
            }
        }

        return null;
    }

    /** @return list<array{version: string, checksum: string}> in version order. */
    private function appliedRows(): array
    {
        $rows = $this->database->fetchAll(
            'SELECT version, checksum FROM ' . self::TABLE . ' ORDER BY version ASC',
        );

        $applied = [];
        foreach ($rows as $row) {
            /** @var mixed $version */
            $version = $row['version'] ?? null;
            /** @var mixed $checksum */
            $checksum = $row['checksum'] ?? null;

            if (!\is_string($version) || !\is_string($checksum)) {
                throw DatabaseException::invariant('The schema_migrations table holds a malformed row.');
            }

            $applied[] = ['version' => $version, 'checksum' => $checksum];
        }

        return $applied;
    }

    /**
     * Creates the registry itself.
     *
     * Not a migration file: it is what makes migration files knowable, so it has
     * to exist before any of them can be recorded. It is `IF NOT EXISTS` for the
     * same reason everything else is.
     */
    private function ensureRegistryTable(): void
    {
        $this->database->executeRaw(
            'CREATE TABLE IF NOT EXISTS ' . self::TABLE . ' ('
            . ' version VARCHAR(16) NOT NULL,'
            . ' name VARCHAR(128) NOT NULL,'
            . ' checksum CHAR(64) NOT NULL,'
            . ' applied_at VARCHAR(24) NOT NULL,'
            . ' PRIMARY KEY (version)'
            . ')',
            'create schema_migrations',
        );
    }

    /**
     * @template T
     * @param \Closure(): T $work
     * @return T
     */
    private function withLock(\Closure $work): mixed
    {
        if ($this->database->settings()->driver() !== 'mysql') {
            return $work();
        }

        $acquired = $this->database->fetchOne(
            'SELECT GET_LOCK(:name, :timeout) AS acquired',
            ['name' => self::LOCK_NAME, 'timeout' => $this->lockTimeoutSeconds],
        );

        if (($acquired['acquired'] ?? null) !== 1) {
            throw DatabaseException::invariant(
                'Another process is already running migrations.',
                ['lock' => self::LOCK_NAME, 'timeoutSeconds' => $this->lockTimeoutSeconds],
            );
        }

        try {
            return $work();
        } finally {
            $this->database->run('SELECT RELEASE_LOCK(:name)', ['name' => self::LOCK_NAME]);
        }
    }
}
