<?php

declare(strict_types=1);

namespace Eszter\Backup;

use Eszter\Database\Database;

/**
 * A logical dump of the tables in {@see BackupSet::TABLES}, and its inverse
 * (ESZ-083).
 *
 * ## Why not `mysqldump`
 *
 * The same reason {@see TarArchive} is not `exec('tar')`: on shared hosting there
 * may be no shell function, no `mysqldump` binary, and no way to hand it a
 * password that does not put the password in the process list. This runs over the
 * connection the application already has, with the credentials it already holds,
 * and works wherever the application itself works.
 *
 * ## Deterministic output
 *
 * Tables in declared order, rows in primary-key order, one `INSERT` per row, no
 * timestamps and no comments that vary between runs. Two dumps of an unchanged
 * database are byte-identical, which is what lets the manifest digest answer "has
 * anything changed since the last backup?" without a diff.
 *
 * ## Values
 *
 * Integers and floats are emitted bare, nulls as `NULL`, and everything else is
 * quoted by PDO against the live connection — so the escaping is the server's own
 * rules for its own character set rather than this file's guess at them. Binary
 * columns are the exception and are emitted as `X'...'` hex literals: `bucket_key`
 * and any future `BINARY` column contain bytes that are not text in any encoding,
 * and quoting them as a string is how a backup silently mangles data it was
 * trusted to preserve.
 *
 * ## No DDL
 *
 * The dump carries rows and nothing else. Schema comes from `migrations/`, which
 * is the same forward-only path a deployment uses, so a restore ends up on a
 * schema the migrator built and recorded rather than one a dump asserted. That
 * also means a backup taken at version 9 can be restored onto the code of version
 * 10: migrate first, load second, and the extra column arrives with its declared
 * default instead of being clobbered by an older `CREATE TABLE`.
 */
final class DatabaseDump
{
    private const HEADER = "-- Eszter logical backup. Rows only; the schema comes from migrations/.\n";

    /**
     * @param list<string> $tables
     * @return array{sql: string, rowCounts: array<string, int>}
     */
    public static function export(Database $database, array $tables): array
    {
        $sql = self::HEADER;
        $rowCounts = [];

        foreach ($tables as $table) {
            self::assertKnownTable($table);

            $rows = $database->fetchAll(
                // Ordered by every column rather than by a primary key this class
                // would have to know: it makes the output deterministic for any
                // table, including one whose key is composite or whose rows are
                // otherwise returned in storage order.
                'SELECT * FROM `' . $table . '` ORDER BY ' . self::orderClause($database, $table),
            );

            $rowCounts[$table] = \count($rows);
            $sql .= "\n-- {$table}: " . \count($rows) . " row(s)\n";

            foreach ($rows as $row) {
                $sql .= self::insert($database, $table, $row) . "\n";
            }
        }

        return ['sql' => $sql, 'rowCounts' => $rowCounts];
    }

    /**
     * Applies a dump to an already-migrated database.
     *
     * One transaction. A restore that failed halfway would leave a database that
     * is neither the old state nor the new one, and there is no third state worth
     * having: either every row lands or none does.
     *
     * Foreign-key checks stay on. {@see BackupSet::TABLES} is ordered so parents
     * precede children, and a set that only loads with the checks disabled is a
     * set with a broken reference in it — which is exactly what a restore is
     * supposed to find out, loudly, rather than absorb.
     *
     * @return int Statements applied.
     */
    public static function import(Database $database, string $sql): int
    {
        $statements = self::statements($sql);

        return $database->transactional(static function (Database $connection) use ($statements): int {
            foreach ($statements as $statement) {
                $connection->executeRaw($statement, 'restore row');
            }

            return \count($statements);
        });
    }

    /**
     * Splits the dump into statements.
     *
     * The dump is this class's own output, so the parse is deliberately literal:
     * one statement per line, comments and blanks dropped, and anything that is
     * not an `INSERT INTO` is refused. That refusal is the point. A restore reads
     * a file that has been off this host — downloaded, stored, perhaps mailed —
     * and a permissive parser would happily run a `DROP` or a `GRANT` that
     * arrived in it. Nothing but row inserts is executable here.
     *
     * Values never contain a newline unescaped: PDO's quoting emits `\n` inside
     * the literal, so a line is always a whole statement.
     *
     * @return list<string>
     */
    private static function statements(string $sql): array
    {
        $statements = [];

        foreach (explode("\n", $sql) as $number => $line) {
            $line = trim($line);

            if ($line === '' || str_starts_with($line, '--')) {
                continue;
            }

            if (!str_starts_with($line, 'INSERT INTO `')) {
                throw new BackupException(
                    'The database dump contains a statement that is not a row insert on line '
                    . ($number + 1) . '; refusing to execute it.',
                );
            }

            $statements[] = rtrim($line, ';');
        }

        return $statements;
    }

    /** @param array<string, mixed> $row */
    private static function insert(Database $database, string $table, array $row): string
    {
        $columns = [];
        $values = [];

        foreach ($row as $column => $value) {
            $columns[] = '`' . $column . '`';
            $values[] = self::literal($database, $value);
        }

        return 'INSERT INTO `' . $table . '` (' . implode(', ', $columns) . ')'
            . ' VALUES (' . implode(', ', $values) . ');';
    }

    private static function literal(Database $database, mixed $value): string
    {
        if ($value === null) {
            return 'NULL';
        }

        if (\is_int($value) || \is_float($value)) {
            return (string) $value;
        }

        if (\is_bool($value)) {
            return $value ? '1' : '0';
        }

        if (!\is_string($value)) {
            // Every remaining PDO type is a string; anything else means the driver
            // returned something this dump has no literal for, and inventing one
            // would put a guess into a backup.
            throw new BackupException(
                'A column value of type ' . get_debug_type($value) . ' has no backup literal.',
            );
        }

        $text = $value;

        // A hex literal for anything that is not valid UTF-8. Quoting raw bytes as
        // a string is how a backup mangles the data it exists to preserve, and the
        // damage is invisible until someone compares digests months later.
        if (!mb_check_encoding($text, 'UTF-8')) {
            return "X'" . bin2hex($text) . "'";
        }

        return $database->pdo()->quote($text);
    }

    /** Every column, in declared order, so the row order is total and stable. */
    private static function orderClause(Database $database, string $table): string
    {
        $columns = $database->fetchAll('SHOW COLUMNS FROM `' . $table . '`');
        $names = [];

        foreach ($columns as $column) {
            /** @var mixed $field */
            $field = $column['Field'] ?? null;

            if (\is_string($field)) {
                $names[] = '`' . $field . '`';
            }
        }

        if ($names === []) {
            throw new BackupException("Table {$table} reports no columns.");
        }

        return implode(', ', $names);
    }

    /**
     * Table names are interpolated — they cannot be bound — so every one of them
     * must come from the declared set and never from a caller or a file.
     */
    private static function assertKnownTable(string $table): void
    {
        if (!\in_array($table, BackupSet::TABLES, true)) {
            throw new BackupException("Refusing to dump a table outside the declared set: {$table}");
        }
    }
}
