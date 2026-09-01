<?php

declare(strict_types=1);

namespace Eszter\Storage;

/**
 * Process-wide barrier between backups and durable application mutations.
 *
 * Backups take the lock exclusively. Participating mutations take it shared,
 * which keeps ordinary writers concurrent while ensuring an archive sees the
 * application either before or after each complete mutation. Acquiring this
 * barrier is always the first locking step, before a content/media lock or a
 * database transaction.
 *
 * Instances for the same path share one process-local acquisition. This is
 * required because a logical operation may enter through Database and then use
 * ContentStorage; taking a second flock on another descriptor can deadlock the
 * process against itself even when both requests are shared.
 */
final class ApplicationSnapshotLock
{
    public const FILE_NAME = 'application-snapshot.lock';

    /** @var array<string, array{handle: resource, exclusive: bool, depth: int}> */
    private static array $held = [];

    private readonly string $path;

    public function __construct(string $lockDirectory)
    {
        $this->path = rtrim($lockDirectory, '/\\') . \DIRECTORY_SEPARATOR . self::FILE_NAME;
    }

    /**
     * @template T
     * @param \Closure(): T $operation
     * @return T
     */
    public function withShared(\Closure $operation): mixed
    {
        return $this->withLock(false, $operation);
    }

    /**
     * @template T
     * @param \Closure(): T $operation
     * @return T
     */
    public function withExclusive(\Closure $operation): mixed
    {
        return $this->withLock(true, $operation);
    }

    /**
     * @template T
     * @param \Closure(): T $operation
     * @return T
     */
    private function withLock(bool $exclusive, \Closure $operation): mixed
    {
        $held = self::$held[$this->path] ?? null;

        if ($held !== null) {
            if ($exclusive && !$held['exclusive']) {
                throw new \LogicException('The application snapshot lock cannot be upgraded in place.');
            }

            ++self::$held[$this->path]['depth'];

            try {
                return $operation();
            } finally {
                $this->release();
            }
        }

        $directory = \dirname($this->path);
        if (!is_dir($directory) && !@mkdir($directory, 0o770, true) && !is_dir($directory)) {
            throw new StorageException(
                StorageException::LOCK_FAILED,
                "Could not create lock directory {$directory}.",
            );
        }

        $handle = @fopen($this->path, 'c');
        if ($handle === false) {
            throw new StorageException(
                StorageException::LOCK_FAILED,
                "Could not open application snapshot lock {$this->path}.",
            );
        }

        if (!flock($handle, $exclusive ? \LOCK_EX : \LOCK_SH)) {
            fclose($handle);
            throw new StorageException(
                StorageException::LOCK_FAILED,
                'Could not acquire the application snapshot lock.',
            );
        }

        self::$held[$this->path] = ['handle' => $handle, 'exclusive' => $exclusive, 'depth' => 1];

        try {
            return $operation();
        } finally {
            $this->release();
        }
    }

    private function release(): void
    {
        $held = self::$held[$this->path] ?? null;
        if ($held === null) {
            return;
        }

        if ($held['depth'] > 1) {
            --self::$held[$this->path]['depth'];

            return;
        }

        flock($held['handle'], \LOCK_UN);
        fclose($held['handle']);
        unset(self::$held[$this->path]);
    }
}
