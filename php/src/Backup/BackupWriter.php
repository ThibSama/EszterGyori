<?php

declare(strict_types=1);

namespace Eszter\Backup;

use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Database\Migrator;
use Eszter\Support\Clock;
use Eszter\Storage\ApplicationSnapshotLock;

/**
 * Assembles one backup archive from a live deployment (ESZ-083).
 *
 * ## Read-only, and it has to be
 *
 * Nothing here creates, seeds or repairs durable application data. The only
 * deployment-side write is the excluded advisory snapshot lock itself. A backup
 * tool that seeded a missing `media-library.json` would be a backup tool
 * that changed the thing it was measuring, and the first person to notice would be
 * someone comparing two backups and finding a file that had appeared without
 * anybody editing anything. A file that is absent is recorded as absent.
 *
 * ## Assembled whole, then written once
 *
 * The entries are collected, the manifest is computed over them, and only then is
 * the archive written — to a temporary name in the destination directory, and
 * renamed into place at the end. An interrupted backup therefore leaves no file at
 * all rather than a short one, because a short archive with a plausible name is
 * the single most dangerous artifact this package could produce: it looks like a
 * backup right up to the moment it is needed.
 */
final class BackupWriter
{
    public function __construct(
        private readonly Configuration $config,
        private readonly Database $database,
        private readonly ContractArtifacts $artifacts,
        private readonly Migrator $migrator,
        private readonly Clock $clock,
        private readonly ?\Closure $afterDatabaseExport = null,
        private readonly ?\Closure $beforePublish = null,
    ) {
    }

    /**
     * Writes the archive and returns what it recorded.
     *
     * @return array{path: string, manifest: BackupManifest, bytes: int}
     */
    public function write(string $destinationDirectory): array
    {
        $this->assertDestination($destinationDirectory);

        $barrier = new ApplicationSnapshotLock($this->config->lockDir);

        return $barrier->withExclusive(fn (): array => $this->writeSnapshot($destinationDirectory));
    }

    /** @return array{path: string, manifest: BackupManifest, bytes: int} */
    private function writeSnapshot(string $destinationDirectory): array
    {
        $entries = [];
        $dump = DatabaseDump::export($this->database, BackupSet::TABLES);
        $entries[BackupSet::DATABASE_FILE] = $dump['sql'];

        if ($this->afterDatabaseExport !== null) {
            ($this->afterDatabaseExport)();
        }

        foreach ($this->contentEntries() as $path => $contents) {
            $entries[$path] = $contents;
        }

        foreach ($this->mediaEntries() as $path => $contents) {
            $entries[$path] = $contents;
        }

        $this->assertWithinSizeCeiling($entries);

        $manifest = BackupManifest::describe(
            $entries,
            $this->clock->nowIso(),
            $this->migrator->appliedVersions(),
            $dump['rowCounts'],
            $this->artifacts->contentSchemaVersion(),
            $this->httpContractVersion(),
            BackupSet::EXCLUDED_TABLES,
        );

        // First in the archive, so a reader can decide what it is holding before
        // it has read a single data byte.
        $archive = [BackupSet::MANIFEST_FILE => $manifest->toJson()] + $entries;

        $path = rtrim($destinationDirectory, '/\\') . \DIRECTORY_SEPARATOR . $this->fileName();
        $temporary = $path . '.partial';

        $empty = @fopen($temporary, 'x');
        if ($empty === false) {
            throw new BackupException("Could not reserve the partial archive: {$temporary}");
        }
        fclose($empty);

        if (!@chmod($temporary, 0o600)) {
            @unlink($temporary);
            throw new BackupException("Could not restrict the partial archive to mode 0600: {$temporary}");
        }

        TarArchive::write($temporary, $archive, $this->clock->now()->getTimestamp());

        // 0600 before the rename, not after: the archive holds every booking and
        // every customer's contact details, and the window between "readable" and
        // "restricted" is a window in which another account on a shared host can
        // read all of it.
        @chmod($temporary, 0o600);

        if ($this->beforePublish !== null) {
            ($this->beforePublish)();
        }

        if (!@rename($temporary, $path)) {
            @unlink($temporary);

            throw new BackupException("Could not move the finished archive into place: {$path}");
        }

        $bytes = filesize($path);

        return ['path' => $path, 'manifest' => $manifest, 'bytes' => $bytes === false ? 0 : $bytes];
    }

    /** @return array<string, string> */
    private function contentEntries(): array
    {
        $entries = [];

        foreach (BackupSet::CONTENT_FILES as $file) {
            $path = $this->config->contentDir . \DIRECTORY_SEPARATOR . $file;

            if (!is_file($path)) {
                continue;
            }

            $entries[BackupSet::CONTENT_PREFIX . $file] = self::read($path);
        }

        return $entries;
    }

    /**
     * Originals and derivatives, both, and neither directory's transient files.
     *
     * `.intake/` is a child of the originals directory — it is placed there so
     * finalising an original is a rename that cannot cross a filesystem — so a
     * naive walk would sweep up half-verified uploads. {@see BackupSet::isTransient()}
     * is what keeps them out, and it is applied to both directories rather than
     * only to the one where the problem is currently known to exist.
     *
     * @return array<string, string>
     */
    private function mediaEntries(): array
    {
        return $this->filesUnder($this->config->mediaOriginalsDir, BackupSet::ORIGINALS_PREFIX)
            + $this->filesUnder($this->config->mediaPublicDir(), BackupSet::DERIVATIVES_PREFIX);
    }

    /** @return array<string, string> */
    private function filesUnder(string $directory, string $prefix): array
    {
        if (!is_dir($directory)) {
            return [];
        }

        $entries = [];
        $names = scandir($directory);

        if ($names === false) {
            throw new BackupException("Could not list {$directory}.");
        }

        sort($names);

        foreach ($names as $name) {
            if ($name === '.' || $name === '..' || BackupSet::isTransient($name)) {
                continue;
            }

            $path = $directory . \DIRECTORY_SEPARATOR . $name;

            // Not recursive, and not by oversight: both media directories are flat
            // by construction — every file in them is named by the contract's asset
            // id pattern. A subdirectory is something this application did not
            // create, and copying it into a backup would be copying something
            // nobody declared.
            if (!is_file($path) || is_link($path)) {
                continue;
            }

            $entries[$prefix . $name] = self::read($path);
        }

        return $entries;
    }

    /** @param array<string, string> $entries */
    private function assertWithinSizeCeiling(array $entries): void
    {
        $total = 0;

        foreach ($entries as $contents) {
            $total += \strlen($contents);
        }

        if ($total > BackupSet::MAX_TOTAL_BYTES) {
            throw new BackupException(\sprintf(
                'The backup set is %d bytes, over the %d byte ceiling. Refusing rather than '
                . 'risking an out-of-memory failure partway through writing a file that would '
                . 'look like a backup.',
                $total,
                BackupSet::MAX_TOTAL_BYTES,
            ));
        }
    }

    private function assertDestination(string $directory): void
    {
        if (!is_dir($directory)) {
            throw new BackupException("The backup destination does not exist: {$directory}");
        }

        if (!is_writable($directory)) {
            throw new BackupException("The backup destination is not writable: {$directory}");
        }

        // The destination must not be inside the document root. An archive of every
        // booking and every customer's contact details, sitting under a directory
        // Apache serves, is a data breach one guessed filename away — and the file
        // name is a timestamp, which is not much of a guess.
        $public = realpath($this->config->publicDir);
        $target = realpath($directory);

        $isInsidePublic = $public !== false
            && $target !== false
            && str_starts_with($target . \DIRECTORY_SEPARATOR, $public . \DIRECTORY_SEPARATOR);

        if ($isInsidePublic) {
            throw new BackupException(
                "Refusing to write a backup inside the document root: {$directory}. "
                . 'The archive carries customer data and everything under the document root is served.',
            );
        }
    }

    private function fileName(): string
    {
        // Sorts chronologically as a plain string, which is what an operator needs
        // from a directory listing when they are looking for "the most recent one".
        return 'eszter-backup-'
            . $this->clock->now()->format('Ymd-His')
            . '.tar.gz';
    }

    private function httpContractVersion(): int
    {
        /** @var mixed $version */
        $version = $this->artifacts->httpContract()['httpContractVersion'] ?? null;

        return \is_int($version) ? $version : 0;
    }

    private static function read(string $path): string
    {
        $contents = @file_get_contents($path);

        if ($contents === false) {
            throw new BackupException("Could not read {$path} for the backup.");
        }

        return $contents;
    }
}
