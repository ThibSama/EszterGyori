<?php

declare(strict_types=1);

namespace Eszter\Backup;

use Eszter\Config\Configuration;
use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Database\Database;
use Eszter\Database\Migrator;
use Eszter\Media\ImagePipeline;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaLibrary;
use Eszter\Storage\ApplicationSnapshotLock;

/**
 * Applies one backup archive to a deployment (ESZ-083).
 *
 * ## Verify everything, then write anything
 *
 * The archive, manifest, SQL grammar, schema direction and content/media
 * contracts are checked before any mutation. Files are then staged and synced.
 * Live files are replaced reversibly while the database transaction remains
 * uncommitted; any throwable restores the moved-aside files and rolls SQL back.
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
 * The dump carries no DDL, so the target ends up on a
 * schema this application built and recorded. That is what lets a backup taken at
 * version 9 be restored onto version 10: the new column arrives with its declared
 * default rather than being erased by an older `CREATE TABLE`. A backup from a
 * *newer* schema than the application is refused instead — it may carry columns this
 * code has no place to put, and silently dropping them is data loss disguised as
 * success.
 */
final class BackupRestore
{
    public function __construct(
        private readonly Configuration $config,
        private readonly Database $database,
        private readonly Migrator $migrator,
        /** @var (\Closure(string): void)|null Deterministic project-owned test seam. */
        private readonly ?\Closure $failureInjector = null,
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

        $sql = $archive[BackupSet::DATABASE_FILE] ?? null;
        if ($sql === null) {
            throw new BackupException('The archive carries no database dump.');
        }

        // The dump and every file are parsed against their actual execution and
        // product contracts here. Nothing below this point can discover a
        // deterministic refusal after DDL, DML or a live-file replacement.
        DatabaseDump::validate($sql, [Migrator::TABLE]);
        [$desired, $ownedTargets] = $this->preflightFiles($archive);

        $schema = $this->migrator->inspect();
        $this->assertApplicationCanHoldTheBackup($manifest, [...$schema['applied'], ...$schema['pending']]);
        $populated = $this->targetIsPopulated($schema['registryExists']);

        if (!$overwrite && $populated) {
            throw new BackupException(
                'Refusing to restore over a target that already holds restore-owned data or files. '
                    . 'Pass --overwrite if replacing it is what you mean.',
            );
        }

        if ($populated && $schema['pending'] !== []) {
            throw new BackupException(
                'Refusing to restore a populated target while migrations are pending: '
                    . implode(', ', $schema['pending'])
                    . '. Apply and verify migrations separately before restoring.',
            );
        }

        $this->inject('after_preflight');

        $filesystem = new RestoreFilesystemTransaction($desired, $ownedTargets);
        $filesystem->stage();

        try {
            $this->inject('before_database_replacement');

            // DDL is allowed only for a target preflight proved empty. A populated
            // target with pending migrations was already refused above.
            $applied = $schema['pending'] === [] ? [] : $this->migrator->migrate();

            $files = 0;
            $statements = $this->database->transactional(function (Database $connection) use (
                $sql,
                $filesystem,
                &$files,
            ): int {
                foreach (array_reverse(BackupSet::TABLES) as $table) {
                    if ($table !== Migrator::TABLE) {
                        $connection->executeRaw('DELETE FROM `' . $table . '`', "clear {$table}");
                    }
                }

                $count = DatabaseDump::import($connection, $sql, [Migrator::TABLE]);
                $this->inject('after_database_replacement');
                $files = $filesystem->install($this->failureInjector);
                $this->inject('after_filesystem_installation');

                return $count;
            });

            // `transactional()` has committed before returning. Only now may the
            // old filesystem copies cease to be rollback material.
            $filesystem->commit();
        } catch (\Throwable $failure) {
            try {
                $filesystem->rollBack();
            } catch (\Throwable $compensationFailure) {
                throw new BackupException(
                    'Restore failed and could not restore the complete old filesystem state: '
                        . $compensationFailure->getMessage(),
                    previous: $failure,
                );
            }

            throw $failure;
        }

        return [
            'manifest' => $manifest,
            'statements' => $statements,
            'files' => $files,
            'migrations' => $applied,
        ];
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
     * Validates all restorable bytes and computes the exact live-file transaction
     * before staging or mutation.
     *
     * @param array<string, string> $archive
     * @return array{0: array<string, array{path: string, contents: string, mode: int}>, 1: list<string>}
     */
    private function preflightFiles(array $archive): array
    {
        $artifacts = new ContractArtifacts($this->config->contractsDir);
        $artifacts->verifyAll();
        $contentValidator = ContentValidator::create($artifacts);
        $structural = new StructuralValidator($artifacts);
        $media = MediaContract::fromArtifacts($artifacts);
        $images = new ImagePipeline($media);
        $contentLimit = $artifacts->storageLimitBytes('contentFileLimitBytes');
        $catalogueLimit = $artifacts->storageLimitBytes('mediaLibraryIndexLimitBytes');

        $desired = [];
        foreach ($archive as $path => $contents) {
            if ($path === BackupSet::MANIFEST_FILE || $path === BackupSet::DATABASE_FILE) {
                continue;
            }

            $target = $this->targetFor($path);
            if ($target === null || !$this->isDeclaredArchivePath($path, $media)) {
                throw new BackupException("The archive contains undeclared restore entry {$path}.");
            }

            if (is_link($target)) {
                throw new BackupException("Refusing to replace restore-owned symlink {$target}.");
            }

            $desired[$path] = ['path' => $target, 'contents' => $contents, 'mode' => $this->modeFor($path)];
        }

        foreach (['draft.json', 'published.json'] as $file) {
            $path = BackupSet::CONTENT_PREFIX . $file;
            if (!isset($archive[$path])) {
                continue;
            }
            if (\strlen($archive[$path]) > $contentLimit) {
                throw new BackupException("Restored {$file} exceeds the product content-file ceiling.");
            }
            $decoded = $this->decodeJson($archive[$path], $file);
            $target = $file === 'draft.json'
                ? ContentValidator::TARGET_SERVER_DRAFT_ENVELOPE
                : ContentValidator::TARGET_PUBLISHED_ENVELOPE;
            $result = $contentValidator->validate($decoded, $target);
            if (!$result->valid) {
                throw new BackupException("Restored {$file} fails product validation: " . $result->summary());
            }
            if ($result->value !== $decoded) {
                throw new BackupException("Restored {$file} is valid but not in canonical stored form.");
            }
        }

        $cataloguePath = BackupSet::CONTENT_PREFIX . MediaLibrary::INDEX_FILE;
        $assets = [];
        if (isset($archive[$cataloguePath])) {
            if (\strlen($archive[$cataloguePath]) > $catalogueLimit) {
                throw new BackupException('The restored media catalogue exceeds its product ceiling.');
            }
            $catalogue = $this->decodeJson($archive[$cataloguePath], MediaLibrary::INDEX_FILE);
            $issues = $structural->validate($catalogue, MediaLibrary::INDEX_SCHEMA);
            if ($issues !== [] || !\is_array($catalogue['assets'] ?? null)) {
                throw new BackupException(
                    'The restored media catalogue fails product validation: ' . \count($issues) . ' issue(s).',
                );
            }
            /** @var list<array<string, mixed>> $assets */
            $assets = $catalogue['assets'];
        }

        $expectedMedia = [];
        foreach ($assets as $asset) {
            $id = $asset['id'] ?? null;
            $mime = $asset['mimeType'] ?? null;
            if (!\is_string($id) || !\is_string($mime) || !$media->isAssetId($id) || !$media->accepts($mime)) {
                throw new BackupException('The restored media catalogue contains an invalid asset identity.');
            }

            $name = $media->fileNameFor($id, $mime);
            if (($asset['path'] ?? null) !== $media->publicPathFor($id, $mime)) {
                throw new BackupException("The restored media catalogue path for {$id} is inconsistent.");
            }

            $originalPath = BackupSet::ORIGINALS_PREFIX . $name;
            $derivativePath = BackupSet::DERIVATIVES_PREFIX . $name;
            foreach ([$originalPath, $derivativePath] as $required) {
                if (!isset($archive[$required])) {
                    throw new BackupException("The restored media catalogue names missing file {$required}.");
                }
                $expectedMedia[$required] = true;
            }

            $originalInfo = @getimagesizefromstring($archive[$originalPath]);
            $derivativeInfo = @getimagesizefromstring($archive[$derivativePath]);
            if (
                $originalInfo === false
                || $derivativeInfo === false
                || $originalInfo['mime'] !== $mime
                || $derivativeInfo['mime'] !== $mime
                || $this->detectedMime($archive[$originalPath]) !== $mime
                || $this->detectedMime($archive[$derivativePath]) !== $mime
                || !$images->isWithinBounds([
                    'width' => $originalInfo[0],
                    'height' => $originalInfo[1],
                    'mimeType' => $mime,
                ])
                || !$images->isWithinBounds([
                    'width' => $derivativeInfo[0],
                    'height' => $derivativeInfo[1],
                    'mimeType' => $mime,
                ])
                || !$this->imageIsComplete($archive[$originalPath], $mime)
                || !$this->imageIsComplete($archive[$derivativePath], $mime)
                || \strlen($archive[$originalPath]) > $media->uploadLimitBytes
                || ($asset['byteSize'] ?? null) !== \strlen($archive[$derivativePath])
                || ($asset['width'] ?? null) !== $derivativeInfo[0]
                || ($asset['height'] ?? null) !== $derivativeInfo[1]
                || $originalInfo[0] !== $derivativeInfo[0]
                || $originalInfo[1] !== $derivativeInfo[1]
            ) {
                throw new BackupException("Restored media bytes for {$id} violate the media catalogue invariants.");
            }
        }

        foreach (array_keys($archive) as $path) {
            if (
                (str_starts_with($path, BackupSet::ORIGINALS_PREFIX)
                    || str_starts_with($path, BackupSet::DERIVATIVES_PREFIX))
                && !isset($expectedMedia[$path])
            ) {
                throw new BackupException("The archive contains uncatalogued media file {$path}.");
            }
        }

        $ownedTargets = [];
        foreach (BackupSet::CONTENT_FILES as $file) {
            $target = $this->config->contentDir . \DIRECTORY_SEPARATOR . $file;
            if (is_link($target)) {
                throw new BackupException("Refusing restore ownership over symlink {$target}.");
            }
            if (is_file($target)) {
                $ownedTargets[] = $target;
            }
        }
        foreach ([$this->config->mediaOriginalsDir, $this->config->mediaPublicDir()] as $directory) {
            foreach ($this->ownedMediaTargets($directory, $media) as $target) {
                $ownedTargets[] = $target;
            }
        }

        return [$desired, array_values(array_unique($ownedTargets))];
    }

    private function isDeclaredArchivePath(string $path, MediaContract $media): bool
    {
        if (str_starts_with($path, BackupSet::CONTENT_PREFIX)) {
            return \in_array(substr($path, \strlen(BackupSet::CONTENT_PREFIX)), BackupSet::CONTENT_FILES, true)
                && substr_count($path, '/') === 1;
        }

        foreach ([BackupSet::ORIGINALS_PREFIX, BackupSet::DERIVATIVES_PREFIX] as $prefix) {
            if (str_starts_with($path, $prefix)) {
                return substr_count($path, '/') === 1
                    && $this->isOwnedMediaName(substr($path, \strlen($prefix)), $media);
            }
        }

        return false;
    }

    private function isOwnedMediaName(string $name, MediaContract $media): bool
    {
        $dot = strrpos($name, '.');
        if ($dot === false) {
            return false;
        }

        $id = substr($name, 0, $dot);
        $extension = substr($name, $dot + 1);
        if (!$media->isAssetId($id)) {
            return false;
        }

        return \in_array($extension, array_values($media->extensionsByMimeType), true);
    }

    /** @return list<string> */
    private function ownedMediaTargets(string $directory, MediaContract $media): array
    {
        if (!is_dir($directory)) {
            return [];
        }

        $names = scandir($directory);
        if ($names === false) {
            throw new BackupException("Could not inspect restore ownership under {$directory}.");
        }

        $targets = [];
        foreach ($names as $name) {
            if ($name === '.' || $name === '..' || !$this->isOwnedMediaName($name, $media)) {
                continue;
            }
            $target = $directory . \DIRECTORY_SEPARATOR . $name;
            if (is_link($target)) {
                throw new BackupException("Refusing restore ownership over symlink {$target}.");
            }
            if (is_file($target)) {
                $targets[] = $target;
            }
        }

        return $targets;
    }

    /** @return array<string, mixed> */
    private function decodeJson(string $contents, string $role): array
    {
        try {
            $decoded = json_decode($contents, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $failure) {
            throw new BackupException("Restored {$role} contains invalid JSON.", previous: $failure);
        }

        if (!\is_array($decoded)) {
            throw new BackupException("Restored {$role} is not a JSON object.");
        }

        /** @var array<string, mixed> */
        return $decoded;
    }

    private function detectedMime(string $contents): ?string
    {
        $finfo = @finfo_open(\FILEINFO_MIME_TYPE);
        if ($finfo === false) {
            throw new BackupException('The host cannot verify restored media types: ext-fileinfo is unavailable.');
        }

        $detected = @finfo_buffer($finfo, $contents);

        return \is_string($detected) && $detected !== '' ? $detected : null;
    }

    private function imageIsComplete(string $contents, string $mime): bool
    {
        if (\strlen($contents) < 12) {
            return false;
        }

        if ($mime === 'image/webp') {
            if (substr($contents, 0, 4) !== 'RIFF') {
                return false;
            }
            /** @var array{1: int}|false $declared */
            $declared = unpack('V', substr($contents, 4, 4));

            return $declared !== false && $declared[1] + 8 <= \strlen($contents);
        }

        $tail = substr($contents, -ImagePipeline::TERMINATOR_WINDOW_BYTES);
        return match ($mime) {
            'image/jpeg' => str_contains($tail, "\xFF\xD9"),
            'image/png' => str_contains($tail, "IEND\xAE\x42\x60\x82"),
            default => false,
        };
    }

    /** Read-only population check usable even when only some migrations exist. */
    private function targetIsPopulated(bool $registryExists): bool
    {
        if ($registryExists) {
            foreach (BackupSet::TABLES as $table) {
                if ($table === Migrator::TABLE || !$this->tableExists($table)) {
                    continue;
                }
                $row = $this->database->fetchOne('SELECT COUNT(*) AS total FROM `' . $table . '`');
                if ($this->countFrom($row, "table {$table}") > 0) {
                    return true;
                }
            }
        }

        foreach (BackupSet::CONTENT_FILES as $file) {
            $path = $this->config->contentDir . \DIRECTORY_SEPARATOR . $file;
            if (!is_file($path)) {
                continue;
            }
            $decoded = json_decode((string) @file_get_contents($path), true);
            if (!\is_array($decoded)) {
                return true;
            }
            if ($file === MediaLibrary::INDEX_FILE) {
                if (($decoded['assets'] ?? []) !== []) {
                    return true;
                }
            } else {
                $revision = $decoded['revision'] ?? null;
                if (!\is_int($revision) || $revision < 0) {
                    return true;
                }
                if ($revision > 0) {
                    return true;
                }
            }
        }

        $artifacts = new ContractArtifacts($this->config->contractsDir);
        $media = MediaContract::fromArtifacts($artifacts);
        return $this->ownedMediaTargets($this->config->mediaOriginalsDir, $media) !== []
            || $this->ownedMediaTargets($this->config->mediaPublicDir(), $media) !== [];
    }

    private function tableExists(string $table): bool
    {
        $row = $this->database->fetchOne(
            'SELECT COUNT(*) AS total FROM information_schema.tables'
                . ' WHERE table_schema = DATABASE() AND table_name = :table',
            ['table' => $table],
        );

        return $this->countFrom($row, "table {$table} existence") === 1;
    }

    /** @param array<string, mixed>|null $row */
    private function countFrom(?array $row, string $role): int
    {
        $total = $row['total'] ?? null;
        if (!\is_int($total) && !(\is_string($total) && ctype_digit($total))) {
            throw new BackupException("Database returned a malformed count for {$role}.");
        }

        return (int) $total;
    }

    /** @param list<string> $available */
    private function assertApplicationCanHoldTheBackup(BackupManifest $manifest, array $available): void
    {
        $missing = array_values(array_diff($manifest->appliedMigrations, $available));

        if ($missing !== []) {
            throw new BackupException(\sprintf(
                'The backup was taken at migration(s) this application does not have: %s. '
                    . 'Restore it with the release it was taken from.',
                implode(', ', $missing),
            ));
        }
    }

    private function inject(string $phase): void
    {
        if ($this->failureInjector !== null) {
            ($this->failureInjector)($phase);
        }
    }
}
