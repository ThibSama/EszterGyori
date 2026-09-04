<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * Rotates and expires only the repository-owned log names.
 *
 * PHP requests and cron commands have short-lived Logger instances, so no
 * daemon keeps an old file descriptor after rename. The active file is left
 * absent and the next Logger open recreates it privately.
 */
final class LogMaintenance
{
    public const RETENTION_DAYS = 30;

    /** Extend this list whenever a new command adds a Logger target. */
    public const MANAGED_LOG_FILES = ['app.log', 'notifications.log', 'retention.log'];

    /**
     * @param string $logDir Configured private log directory.
     * @param Clock $clock Calendar authority for rotation and retention.
     * @param list<string> $managedLogFiles
     */
    public function __construct(
        private readonly string $logDir,
        private readonly Clock $clock,
        private readonly array $managedLogFiles = self::MANAGED_LOG_FILES,
    ) {
    }

    /** @return array{rotated: list<string>, deleted: list<string>} */
    public function run(): array
    {
        if (is_link($this->logDir)) {
            throw new LogMaintenanceException("refusing symlink log directory {$this->logDir}");
        }
        if (!file_exists($this->logDir)) {
            return ['rotated' => [], 'deleted' => []];
        }
        if (!is_dir($this->logDir) || !is_readable($this->logDir)) {
            throw new LogMaintenanceException("log directory is not safely listable {$this->logDir}");
        }

        $names = @scandir($this->logDir);
        if ($names === false) {
            throw new LogMaintenanceException("log directory is not safely listable {$this->logDir}");
        }

        $archives = $this->managedArchives($names);
        $activePaths = [];
        foreach ($this->managedLogFiles as $base) {
            $path = $this->logDir . \DIRECTORY_SEPARATOR . $base;
            if (is_link($path)) {
                throw new LogMaintenanceException("refusing symlink target {$path}");
            }
            if (file_exists($path)) {
                if (!is_file($path)) {
                    throw new LogMaintenanceException("refusing non-regular target {$path}");
                }
                $activePaths[] = $path;
            }
        }
        foreach (array_keys($archives) as $path) {
            if (is_link($path)) {
                throw new LogMaintenanceException("refusing symlink target {$path}");
            }
            if (!is_file($path)) {
                throw new LogMaintenanceException("refusing non-regular target {$path}");
            }
        }

        foreach ([...$activePaths, ...array_keys($archives)] as $path) {
            $this->restrict($path);
        }

        $rotated = [];
        foreach ($activePaths as $path) {
            $mtime = @filemtime($path);
            if ($mtime === false) {
                throw new LogMaintenanceException("cannot read target modification time {$path}");
            }
            $date = (new \DateTimeImmutable('@' . $mtime))
                ->setTimezone($this->clock->now()->getTimezone())
                ->format('Ymd');
            $archive = $path . '.' . $date;
            if (file_exists($archive) || is_link($archive)) {
                continue;
            }
            if (!@rename($path, $archive)) {
                throw new LogMaintenanceException("cannot rotate target {$path}");
            }
            $this->restrict($archive);
            $rotated[] = $archive;
            $archives[$archive] = $date;
        }

        $cutoff = $this->clock->now()->setTime(0, 0)->modify('-' . self::RETENTION_DAYS . ' days')->format('Ymd');
        $deleted = [];
        ksort($archives);
        foreach ($archives as $path => $date) {
            if ($date >= $cutoff) {
                continue;
            }
            if (!@unlink($path)) {
                throw new LogMaintenanceException("cannot delete expired archive {$path}");
            }
            $deleted[] = $path;
        }

        sort($rotated);

        return ['rotated' => $rotated, 'deleted' => $deleted];
    }

    /**
     * @param list<string> $names
     * @return array<string, string>
     */
    private function managedArchives(array $names): array
    {
        $archives = [];

        foreach ($this->managedLogFiles as $base) {
            $pattern = '/^' . preg_quote($base, '/') . '\\.(\\d{8})$/D';
            foreach ($names as $name) {
                if (preg_match($pattern, $name, $match) !== 1 || !$this->isRealDate($match[1])) {
                    continue;
                }
                $archives[$this->logDir . \DIRECTORY_SEPARATOR . $name] = $match[1];
            }
        }

        return $archives;
    }

    /**
     * @param string $date Compact archive date.
     * @return bool True only for a real calendar date in YYYYMMDD form.
     */
    private function isRealDate(string $date): bool
    {
        $parsed = \DateTimeImmutable::createFromFormat('!Ymd', $date);

        return $parsed !== false && $parsed->format('Ymd') === $date;
    }

    /** @param string $path Managed regular file whose effective mode must become 0600. */
    private function restrict(string $path): void
    {
        $applied = @chmod($path, Logger::FILE_MODE);
        $actual = @fileperms($path);

        if (!$applied || $actual === false || ($actual & 0o777) !== Logger::FILE_MODE) {
            throw new LogMaintenanceException("cannot restrict target to mode 0600 {$path}");
        }
    }
}
