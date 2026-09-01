<?php

declare(strict_types=1);

namespace Eszter\Backup;

/**
 * Reversible filesystem half of a restore.
 *
 * New bytes are fully written and synced before installation. Existing owned
 * files are moved aside, not deleted, until the database commit succeeds. This
 * is compensation across stores, not a claim that several renames are globally
 * atomic.
 */
final class RestoreFilesystemTransaction
{
    /** @var array<string, array{path: string, contents: string, mode: int, staged?: string}> */
    private array $desired;

    /** @var list<string> */
    private array $ownedTargets;

    /** @var array<string, array{stage: string, rollback: string, created: bool}> */
    private array $directories = [];

    /** @var list<array{target: string, backup: string|null, installed: bool}> */
    private array $operations = [];

    /**
     * @param array<string, array{path: string, contents: string, mode: int}> $desired Archive path => target.
     * @param list<string> $ownedTargets Existing restore-owned targets, including stale ones.
     */
    public function __construct(array $desired, array $ownedTargets)
    {
        $this->desired = $desired;
        $this->ownedTargets = $ownedTargets;
    }

    public function stage(): void
    {
        $token = bin2hex(random_bytes(12));

        try {
            foreach ($this->ownedTargets as $target) {
                $this->ensureWorkDirectories(\dirname($target), $token);
            }

            foreach ($this->desired as $archivePath => &$entry) {
                $directory = \dirname($entry['path']);
                $this->ensureWorkDirectories($directory, $token);
                $staged = $this->directories[$directory]['stage'] . \DIRECTORY_SEPARATOR . basename($entry['path']);
                $this->write($staged, $entry['contents'], $entry['mode'], $archivePath);
                $entry['staged'] = $staged;
            }
            unset($entry);
        } catch (\Throwable $failure) {
            $this->discard();
            throw $failure;
        }
    }

    /** @param (\Closure(string): void)|null $failureInjector */
    public function install(?\Closure $failureInjector = null): int
    {
        $byTarget = [];
        foreach ($this->desired as $archivePath => $entry) {
            $byTarget[$entry['path']] = $archivePath;
        }

        $targets = array_values(array_unique([...$this->ownedTargets, ...array_keys($byTarget)]));
        sort($targets);
        $written = 0;

        foreach ($targets as $target) {
            $directory = \dirname($target);
            $archivePath = $byTarget[$target] ?? null;
            $backup = null;

            if (is_link($target)) {
                throw new BackupException("Refusing to replace restore-owned symlink {$target}.");
            }

            if (is_file($target)) {
                $backup = $this->directories[$directory]['rollback']
                    . \DIRECTORY_SEPARATOR . basename($target);
                if (!@rename($target, $backup)) {
                    throw new BackupException("Could not preserve {$target} for restore rollback.");
                }
            }

            $operation = ['target' => $target, 'backup' => $backup, 'installed' => false];
            $this->operations[] = $operation;
            $index = array_key_last($this->operations);

            if ($archivePath !== null) {
                $staged = $this->desired[$archivePath]['staged'] ?? null;
                if (!\is_string($staged) || !@rename($staged, $target)) {
                    throw new BackupException("Could not install restored entry {$archivePath}.");
                }
                $this->operations[$index]['installed'] = true;
                ++$written;
            }

            if ($failureInjector !== null) {
                $failureInjector('during_filesystem_installation');
            }
        }

        return $written;
    }

    /** Restores every moved-aside file and removes every installed new file. */
    public function rollBack(): void
    {
        $failures = [];

        foreach (array_reverse($this->operations) as $operation) {
            if ($operation['installed'] && is_file($operation['target'])) {
                if (!@unlink($operation['target'])) {
                    $failures[] = "remove {$operation['target']}";
                    continue;
                }
            }

            if ($operation['backup'] !== null && is_file($operation['backup'])) {
                if (!@rename($operation['backup'], $operation['target'])) {
                    $failures[] = "restore {$operation['target']}";
                }
            }
        }

        $this->discard();

        if ($failures !== []) {
            throw new BackupException(
                'Restore failed and filesystem compensation was incomplete: ' . implode(', ', $failures),
            );
        }
    }

    /** Deletes rollback copies only after the database commit succeeded. */
    public function commit(): void
    {
        $this->discard();
    }

    private function ensureWorkDirectories(string $directory, string $token): void
    {
        if (isset($this->directories[$directory])) {
            return;
        }

        $created = false;
        if (!is_dir($directory)) {
            if (!@mkdir($directory, 0o770, true) && !is_dir($directory)) {
                throw new BackupException("Could not create {$directory} for restore staging.");
            }
            $created = true;
        }

        $stage = $directory . \DIRECTORY_SEPARATOR . '.restore-stage-' . $token;
        $rollback = $directory . \DIRECTORY_SEPARATOR . '.restore-rollback-' . $token;

        if (!@mkdir($stage, 0o700) || !@mkdir($rollback, 0o700)) {
            @rmdir($stage);
            @rmdir($rollback);
            if ($created) {
                @rmdir($directory);
            }
            throw new BackupException("Could not create restore work directories under {$directory}.");
        }

        $this->directories[$directory] = [
            'stage' => $stage,
            'rollback' => $rollback,
            'created' => $created,
        ];
    }

    private function write(string $path, string $contents, int $mode, string $archivePath): void
    {
        $handle = @fopen($path, 'xb');
        if ($handle === false) {
            throw new BackupException("Could not stage restored entry {$archivePath}.");
        }

        try {
            if (@fwrite($handle, $contents) !== \strlen($contents) || !@fflush($handle)) {
                throw new BackupException("Could not stage restored entry {$archivePath}.");
            }
            if (\function_exists('fsync') && !@fsync($handle)) {
                throw new BackupException("Could not sync restored entry {$archivePath}.");
            }
        } catch (\Throwable $failure) {
            fclose($handle);
            @unlink($path);
            throw $failure;
        }

        fclose($handle);
        if (!@chmod($path, $mode)) {
            @unlink($path);
            throw new BackupException("Could not restrict staged entry {$archivePath}.");
        }
    }

    private function discard(): void
    {
        foreach ($this->directories as $directory => $work) {
            foreach ([$work['stage'], $work['rollback']] as $path) {
                $names = is_dir($path) ? (scandir($path) ?: []) : [];
                foreach ($names as $name) {
                    if ($name !== '.' && $name !== '..') {
                        @unlink($path . \DIRECTORY_SEPARATOR . $name);
                    }
                }
                @rmdir($path);
            }

            if ($work['created']) {
                @rmdir($directory);
            }
        }

        $this->directories = [];
    }
}
