<?php

declare(strict_types=1);

namespace Eszter\Backup;

use Eszter\Retention\RetentionPolicy;
use Eszter\Support\Clock;

/**
 * Expires the archives `BackupWriter` published into one directory (ESZ-162).
 *
 * The bound is `RetentionPolicy::backupArchiveRetentionDays`, consumed from the
 * frozen `customerDataRetention` block rather than restated: an archive carries
 * every booking's customer data, so it is a personal-data store with the same
 * product policy as the rest of the retention path.
 *
 * ## Only after a publish, and only the canonical names
 *
 * Rotation runs once per successful backup and is handed the archive that was
 * just published. It refuses when that archive is not a regular file in the
 * directory, so a backup that failed to publish can never prune the archives
 * that still exist. It considers only `eszter-backup-YYYYMMDD-HHMMSS.tar.gz`
 * names that carry a real timestamp — a `.partial`, an operator's renamed copy
 * or anything else in the directory is not this class's to touch — and it refuses
 * before deleting anything if a canonical name is a symlink or not a regular file.
 *
 * ## Exact boundary
 *
 * An archive is deleted only when its timestamp is strictly older than
 * `now - backupArchiveRetentionDays`; one sitting exactly on the boundary is
 * kept. Copies made elsewhere and provider snapshots are outside this directory
 * and therefore outside this class: they remain the operator's and provider's
 * responsibility, as `docs/backup-and-restore.md` records.
 */
final class BackupRotation
{
    public const ARCHIVE_PATTERN = '/^eszter-backup-(\d{8}-\d{6})\.tar\.gz$/D';

    public function __construct(
        private readonly RetentionPolicy $policy,
        private readonly Clock $clock,
    ) {
    }

    /**
     * @param string $directory The directory `BackupWriter` published into.
     * @param string $publishedArchive The archive the current backup just published.
     * @return array{deleted: list<string>, retentionDays: int}
     */
    public function run(string $directory, string $publishedArchive): array
    {
        $directory = rtrim($directory, '/\\');
        $this->assertPublished($directory, $publishedArchive);

        if (is_link($directory)) {
            throw new BackupException("Refusing to rotate a symlinked backup directory: {$directory}");
        }
        $names = is_dir($directory) ? @scandir($directory) : false;
        if ($names === false) {
            throw new BackupException("The backup directory is not safely listable: {$directory}");
        }

        $archives = [];
        foreach ($names as $name) {
            $stamp = $this->canonicalStamp($name);
            if ($stamp === null) {
                continue;
            }
            $path = $directory . \DIRECTORY_SEPARATOR . $name;
            if (is_link($path)) {
                throw new BackupException("Refusing to rotate a symlinked archive name: {$path}");
            }
            if (!is_file($path)) {
                throw new BackupException("Refusing to rotate a non-regular archive name: {$path}");
            }
            $archives[$path] = $stamp;
        }

        // The names carry whole seconds, so the cutoff is compared at that precision:
        // `SystemClock` is sub-second, and an unrounded `now` would make the archive
        // sitting exactly on the boundary a few microseconds too old.
        $now = $this->clock->now();
        $cutoff = $now
            ->setTime((int) $now->format('G'), (int) $now->format('i'), (int) $now->format('s'))
            ->modify('-' . $this->policy->backupArchiveRetentionDays . ' days');
        $published = $directory . \DIRECTORY_SEPARATOR . basename($publishedArchive);
        $deleted = [];
        ksort($archives);
        foreach ($archives as $path => $stamp) {
            if ($path === $published || $stamp >= $cutoff) {
                continue;
            }
            if (!@unlink($path)) {
                throw new BackupException("Could not delete the expired archive: {$path}");
            }
            $deleted[] = $path;
        }

        return ['deleted' => $deleted, 'retentionDays' => $this->policy->backupArchiveRetentionDays];
    }

    /**
     * The publish guard: rotation is a consequence of a successful backup, never a
     * substitute for one, so the published archive must exist as a regular file in
     * the directory under its canonical name.
     */
    private function assertPublished(string $directory, string $publishedArchive): void
    {
        $expected = $directory . \DIRECTORY_SEPARATOR . basename($publishedArchive);

        if (
            $publishedArchive !== $expected
            || $this->canonicalStamp(basename($publishedArchive)) === null
            || is_link($publishedArchive)
            || !is_file($publishedArchive)
        ) {
            throw new BackupException(
                "Refusing to rotate: no published archive at {$publishedArchive}. "
                . 'Rotation runs only after a backup was written into place.',
            );
        }
    }

    /** Null for anything that is not a canonical archive name with a real timestamp. */
    private function canonicalStamp(string $name): ?\DateTimeImmutable
    {
        if (preg_match(self::ARCHIVE_PATTERN, $name, $match) !== 1) {
            return null;
        }

        // The writer formats the name from the clock's own timezone, so the name
        // is read back in it; a name that does not round-trip (`20260231-...`)
        // is not one the writer produced and is left alone.
        $stamp = \DateTimeImmutable::createFromFormat('!Ymd-His', $match[1], $this->clock->now()->getTimezone());

        return $stamp !== false && $stamp->format('Ymd-His') === $match[1] ? $stamp : null;
    }
}
