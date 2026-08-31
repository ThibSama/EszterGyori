<?php

declare(strict_types=1);

namespace Eszter\Storage;

/**
 * Advisory `flock()` around content access.
 *
 * `docs/hetzner-target-architecture.md` §4 requires the lock to be held for the
 * *whole* read-modify-write, not just the rename, so that two publishes cannot
 * interleave and lose a revision bump.
 *
 * The lock file lives in `data/locks/`, never next to the content it guards: a
 * lock file inside the content directory would itself be a file the storage layer
 * has to explain away.
 *
 * `flock()` is advisory and local-filesystem-only. It is the right tool on shared
 * hosting — it needs no daemon, no SysV IPC and no `pcntl` — but it does not work
 * over NFS, which is why `data/` must be local storage.
 */
final class FileLock
{
    /** @var resource|null */
    private mixed $handle = null;

    public function __construct(private readonly string $path)
    {
    }

    public function isHeld(): bool
    {
        return $this->handle !== null;
    }

    /**
     * Runs $operation while holding the lock, releasing it even on failure.
     *
     * @template T
     * @param callable(): T $operation
     * @return T
     */
    public function withLock(bool $exclusive, callable $operation): mixed
    {
        $this->acquire($exclusive);

        try {
            return $operation();
        } finally {
            $this->release();
        }
    }

    private function acquire(bool $exclusive): void
    {
        // Not reentrant, and deliberately loud about it. One handle backs the
        // whole object, so a nested `withLock` would release the outer lock on
        // its way out and leave the caller running unprotected — a data race that
        // would show up as a corrupted write months later, not as a test failure.
        if ($this->handle !== null) {
            throw new \LogicException(
                'FileLock is not reentrant; a nested withLock() would release the outer lock.',
            );
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
                "Could not open lock file {$this->path}.",
            );
        }

        if (!flock($handle, $exclusive ? LOCK_EX : LOCK_SH)) {
            fclose($handle);

            throw new StorageException(
                StorageException::LOCK_FAILED,
                "Could not acquire " . ($exclusive ? 'an exclusive' : 'a shared')
                    . " lock on {$this->path}.",
            );
        }

        $this->handle = $handle;
    }

    private function release(): void
    {
        if ($this->handle === null) {
            return;
        }

        flock($this->handle, LOCK_UN);
        fclose($this->handle);
        $this->handle = null;
    }
}
