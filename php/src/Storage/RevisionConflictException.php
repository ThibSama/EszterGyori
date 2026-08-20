<?php

declare(strict_types=1);

namespace Eszter\Storage;

/**
 * An optimistic-concurrency precondition failed (ESZ-031).
 *
 * Deliberately **not** a {@see StorageException}. Every storage exception
 * collapses to an opaque 500 `STORAGE_FAILURE`, which is right for a fault the
 * caller can do nothing about and wrong for this one: a conflict is a normal,
 * expected outcome of two editors working at once, the caller can recover from
 * it, and the recovery needs the one number this exception carries.
 *
 * It is raised inside the exclusive lock, before anything has been written, so
 * the guarantee that a conflict leaves storage untouched follows from where it
 * is thrown rather than from a cleanup path that has to be right.
 *
 * `$currentRevision` is the draft head the caller lost to. It is not secret —
 * the caller is authenticated and could read it from the draft route anyway —
 * and it is what lets a client re-read, rebase and retry without guessing.
 */
final class RevisionConflictException extends \RuntimeException
{
    public function __construct(
        public readonly int $expectedRevision,
        public readonly int $currentRevision,
    ) {
        parent::__construct(\sprintf(
            'Expected content revision %d but the draft head is %d.',
            $expectedRevision,
            $currentRevision,
        ));
    }

    /** @return array<string, int> Safe for the log. */
    public function logContext(): array
    {
        return [
            'expectedRevision' => $this->expectedRevision,
            'currentRevision' => $this->currentRevision,
        ];
    }
}
