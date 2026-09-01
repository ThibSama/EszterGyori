<?php

declare(strict_types=1);

namespace Eszter\Backup;

use Eszter\Config\Configuration;
use Eszter\Database\Database;
use Eszter\Database\Migrator;
use Eszter\Storage\ApplicationSnapshotLock;

/**
 * Applies one backup archive to a deployment (ESZ-083).
 *
 * ## Verify everything, then write anything
 *
 * The archive is read, the manifest is parsed, every entry is checked against its
 * recorded digest, and the schema is brought up to date — and only after all of
 * that does a single byte of the target change. A restore that discovered
 * corruption in the last file would already have replaced the database with the
 * first, and the operator would be left with neither the backup nor what they had
 * before.
 *
 * ## Never onto a live install by accident
 *
 * This is the part that decides whether a restore tool is safe to hand to someone
 * at three in the morning. A restore overwrites content and truncates tables, so
 * pointing it at the wrong deployment destroys that deployment. Two independent
 * refusals stand in the way, and each catches a different mistake:
 *
 *  1. **A target that already holds data is refused** unless `$overwrite` is set.
 *     This is the accident: the operator meant the staging config and typed the
 *     production one. Emptiness is judged by the same rows a restore would
 *     replace, not by the presence of a file, so a freshly-migrated database is
 *     empty and a real site never is.
 *  2. **A production environment is refused** unless `$allowProduction` is set as
 *     well. This is the deliberate act that still deserves a second sentence,
 *     because "restore production from last night" and "restore production from
 *     last night onto the wrong host" look identical until afterwards.
 *
 * Neither flag has a default that says yes, and the command spells both of them
 * out in full rather than behind a short option, so neither can be reached by a
 * slip of the hand.
 *
 * ## The schema comes from the migrator, not from the backup
 *
 * `migrate()` runs first and the dump carries no DDL, so the target ends up on a
 * schema this application built and recorded. That is what lets a backup taken at
 * version 9 be restored onto version 10: the new column arrives with its declared
 * default rather than being erased by an older `CREATE TABLE`. A backup from a
 * *newer* schema than the target is refused instead — it may carry columns this
 * code has no place to put, and silently dropping them is data loss disguised as
 * success.
 */
final class BackupRestore
{
    public function __construct(
        private readonly Configuration $config,
        private readonly Database $database,
        private readonly Migrator $migrator,
    ) {
    }

    /**
     * @return array{manifest: BackupManifest, statements: int, files: int, migrations: list<string>}
     */
    public function restore(string $archivePath, bool $overwrite, bool $allowProduction): array
    {
        $barrier = new ApplicationSnapshotLock($this->config->lockDir);

        return $barrier->withExclusive(
            fn (): array => $this->restoreWithSnapshotBarrier($archivePath, $overwrite, $allowProduction),
        );
    }

    /** @return array{manifest: BackupManifest, statements: int, files: int, migrations: list<string>} */
    private function restoreWithSnapshotBarrier(
        string $archivePath,
        bool $overwrite,
        bool $allowProduction,
    ): array {
        if ($this->config->isProduction() && !$allowProduction) {
            throw new BackupException(
                'This configuration names a production environment. Restoring would replace live '
                . 'content and bookings; pass --allow-production to say so explicitly.',
            );
        }

        $archive = TarArchive::read($archivePath);

        if (!isset($archive[BackupSet::MANIFEST_FILE])) {
            throw new BackupException(
                'The archive carries no ' . BackupSet::MANIFEST_FILE . '; it is not an Eszter backup.',
            );
        }

        $manifest = BackupManifest::fromJson($archive[BackupSet::MANIFEST_FILE]);
        $manifest->assertMatches($archive);

        // After verification, before any write. A failure here leaves the target
        // exactly as it was.
        $applied = $this->migrator->migrate();
        $this->assertSchemaCanHoldTheBackup($manifest);

        if (!$overwrite) {
            $this->assertTargetIsEmpty();
        }

        $statements = $this->restoreDatabase($archive[BackupSet::DATABASE_FILE] ?? null);
        $files = $this->restoreFiles($archive);

        return [
            'manifest' => $manifest,
            'statements' => $statements,
            'files' => $files,
            'migrations' => $applied,
        ];
    }

    /**
     * Replaces the contents of every declared table, in one transaction.
     *
     * Deletes rather than truncates. `TRUNCATE` commits implicitly on MySQL, which
     * would end the transaction the restore depends on and leave a failure halfway
     * through as a permanently empty site — the exact opposite of what a restore is
     * for. `DELETE` is slower and is undone by a rollback, and on a table of
     * bookings for one practitioner the speed is not a consideration.
     *
     * Reverse declared order, so children go before their parents and foreign keys
     * never need disabling.
     */
    private function restoreDatabase(?string $sql): int
    {
        if ($sql === null) {
            throw new BackupException('The archive carries no database dump.');
        }

        return $this->database->transactional(function (Database $connection) use ($sql): int {
            foreach (array_reverse(BackupSet::TABLES) as $table) {
                if ($table === Migrator::TABLE) {
                    // Never emptied. It is the migrator's record of what it has
                    // applied to *this* database, and replacing it with the
                    // backup's would tell the migrator a lie about the schema it
                    // is looking at.
                    continue;
                }

                $connection->executeRaw('DELETE FROM `' . $table . '`', "clear {$table}");
            }

            return DatabaseDump::import($connection, self::withoutMigrationRows($sql));
        });
    }

    /**
     * Drops the dump's `schema_migrations` inserts.
     *
     * They are carried in the backup because they are what records the schema the
     * data came from, and the manifest reads them. They are not *applied*, because
     * the target's own migration record describes the target: overwriting it with
     * the source's would leave the migrator believing a version had been applied
     * to a database it had never run against.
     */
    private static function withoutMigrationRows(string $sql): string
    {
        $kept = [];

        foreach (explode("\n", $sql) as $line) {
            if (!str_starts_with(trim($line), 'INSERT INTO `' . Migrator::TABLE . '`')) {
                $kept[] = $line;
            }
        }

        return implode("\n", $kept);
    }

    /**
     * Writes the content and media files.
     *
     * Each file is written to a temporary name beside its target and renamed into
     * place, the same sequence {@see \Eszter\Storage\AtomicJsonFile} uses, so a
     * reader never observes a half-written document even if the restore is
     * interrupted mid-file.
     *
     * @param array<string, string> $archive
     */
    private function restoreFiles(array $archive): int
    {
        $written = 0;

        foreach ($archive as $path => $contents) {
            $target = $this->targetFor($path);

            if ($target === null) {
                continue;
            }

            $directory = \dirname($target);

            if (!is_dir($directory) && !@mkdir($directory, 0o750, true) && !is_dir($directory)) {
                throw new BackupException("Could not create {$directory} for the restore.");
            }

            $temporary = $target . '.restoring';

            if (@file_put_contents($temporary, $contents) !== \strlen($contents)) {
                @unlink($temporary);

                throw new BackupException("Could not write {$target} during the restore.");
            }

            @chmod($temporary, $this->modeFor($path));

            if (!@rename($temporary, $target)) {
                @unlink($temporary);

                throw new BackupException("Could not move the restored {$path} into place.");
            }

            ++$written;
        }

        return $written;
    }

    /**
     * Maps an archive path onto a filesystem path, or null for entries that are
     * not files to restore.
     *
     * A `match` over the three declared prefixes rather than a join onto a base
     * directory: an entry whose prefix is not one of them lands nowhere at all.
     * {@see TarArchive} has already refused any path containing `..`, so this is
     * the second of two independent checks — and the reason there are two is that
     * a restore writes wherever this method says, and that is not a decision to
     * make on one line of validation.
     */
    private function targetFor(string $path): ?string
    {
        $name = basename($path);

        if ($name !== $path && str_starts_with($path, BackupSet::CONTENT_PREFIX)) {
            return \in_array($name, BackupSet::CONTENT_FILES, true)
                ? $this->config->contentDir . \DIRECTORY_SEPARATOR . $name
                : null;
        }

        if (str_starts_with($path, BackupSet::ORIGINALS_PREFIX)) {
            return $this->config->mediaOriginalsDir . \DIRECTORY_SEPARATOR . $name;
        }

        if (str_starts_with($path, BackupSet::DERIVATIVES_PREFIX)) {
            return $this->config->mediaPublicDir() . \DIRECTORY_SEPARATOR . $name;
        }

        // The manifest and the database dump are consumed, not written out.
        return null;
    }

    /**
     * A derivative is served by Apache, which usually runs as another user; the
     * rest is read by this application alone. The same split
     * {@see \Eszter\Media\MediaLibrary} applies when it stores an asset — a restore
     * that produced different permissions from an upload would leave the site
     * working differently depending on how a file got there.
     */
    private function modeFor(string $path): int
    {
        return str_starts_with($path, BackupSet::DERIVATIVES_PREFIX) ? 0o644 : 0o640;
    }

    /**
     * Refuses a target that already holds data.
     *
     * Judged by rows rather than by whether a file exists, because a freshly
     * migrated database has every table and no data — which is exactly the state a
     * restore is for — while a live site has bookings in it. Content files are
     * checked too: a deployment that has served one request has seeded
     * `published.json`, so their presence alone proves nothing, and only a
     * revision past zero means somebody has actually written something.
     */
    private function assertTargetIsEmpty(): void
    {
        foreach (BackupSet::TABLES as $table) {
            if ($table === Migrator::TABLE) {
                continue;
            }

            $row = $this->database->fetchOne('SELECT COUNT(*) AS total FROM `' . $table . '`');
            /** @var mixed $total */
            $total = $row['total'] ?? 0;

            if (\is_int($total) && $total > 0) {
                throw new BackupException(\sprintf(
                    'Refusing to restore over a database that already holds data: `%s` has %d row(s). '
                    . 'Pass --overwrite if replacing it is what you mean.',
                    $table,
                    $total,
                ));
            }
        }

        $published = $this->config->contentDir . \DIRECTORY_SEPARATOR . 'published.json';

        if (!is_file($published)) {
            return;
        }

        /** @var mixed $decoded */
        $decoded = json_decode((string) @file_get_contents($published), true);
        /** @var mixed $revision */
        $revision = \is_array($decoded) ? ($decoded['revision'] ?? 0) : 0;

        if (\is_int($revision) && $revision > 0) {
            throw new BackupException(\sprintf(
                'Refusing to restore over a site that has published content: published.json is at '
                . 'revision %d. Pass --overwrite if replacing it is what you mean.',
                $revision,
            ));
        }
    }

    /**
     * Refuses a backup from a schema newer than the target's.
     *
     * The other direction is fine and is the whole reason the dump carries no DDL:
     * an older backup restored onto a newer schema gets its new columns' declared
     * defaults. A *newer* backup may carry columns this code has nowhere to put,
     * and dropping them silently would be data loss reported as success.
     */
    private function assertSchemaCanHoldTheBackup(BackupManifest $manifest): void
    {
        $applied = $this->migrator->appliedVersions();
        $missing = array_values(array_diff($manifest->appliedMigrations, $applied));

        if ($missing !== []) {
            throw new BackupException(\sprintf(
                'The backup was taken at migration(s) this application does not have: %s. '
                . 'Restore it with the release it was taken from.',
                implode(', ', $missing),
            ));
        }
    }
}
