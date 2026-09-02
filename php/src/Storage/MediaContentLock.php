<?php

declare(strict_types=1);

namespace Eszter\Storage;

/**
 * The cross-domain boundary between media-catalogue mutations and content writes
 * (ESZ-100).
 *
 * `content.lock` serialises content writers against each other and `media.lock`
 * serialises media writers against each other, but nothing used to stand between
 * the two domains. A media delete checks content for references under
 * `media.lock` and then removes the asset; a draft save or publish commits under
 * `content.lock`. Without a shared boundary a content write could land between
 * the delete's "unreferenced" verdict and its removal, leaving a document that
 * points at bytes that just stopped existing.
 *
 * This lock closes exactly that gap, with the smallest primitive that can:
 *
 *  - media deletion takes it **exclusively** across its whole critical section
 *    (reference check, byte removal, catalogue commit), so no content write can
 *    commit while a delete is deciding;
 *  - every content write that can make media references durable — draft save,
 *    publish, reset, and the raw envelope writers — takes it **shared**, so
 *    ordinary saves stay concurrent with each other and only queue behind an
 *    actual delete;
 *  - media finalisation (upload) does not take it: it never reads content, so
 *    there is nothing to serialise it against.
 *
 * ## Lock order
 *
 * The boundary is acquired after the {@see ApplicationSnapshotLock} barrier and
 * before any domain lock:
 *
 * ```
 * application-snapshot.lock  (shared for mutations, exclusive for backups)
 *   → media-content.lock     (exclusive: media delete; shared: content writes)
 *     → media.lock           (media operations)
 *     → content.lock         (content operations)
 * ```
 *
 * A media delete that reads content for its reference check therefore holds
 * `media.lock` then `content.lock`, the established media-then-content order,
 * and no path acquires the boundary after a domain lock, so no inverse path
 * exists. Backups and restores take the snapshot barrier exclusively and never
 * take this lock; they are already excluded from every participant above.
 *
 * Instances for the same path share one process-local acquisition, exactly like
 * {@see ApplicationSnapshotLock}: a logical operation may enter through
 * `MediaLibrary` and then read content through `ContentStorage`, and taking a
 * second flock on another descriptor can deadlock the process against itself
 * even when both requests are the same mode.
 */
final class MediaContentLock
{
    public const FILE_NAME = 'media-content.lock';

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
                throw new \LogicException('The media/content boundary cannot be upgraded in place.');
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
                "Could not open the media/content boundary lock {$this->path}.",
            );
        }

        if (!flock($handle, $exclusive ? \LOCK_EX : \LOCK_SH)) {
            fclose($handle);
            throw new StorageException(
                StorageException::LOCK_FAILED,
                'Could not acquire the media/content boundary lock.',
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
