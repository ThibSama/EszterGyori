<?php

declare(strict_types=1);

namespace Eszter\Storage;

/**
 * A content storage operation failed.
 *
 * The codes mirror the reference implementation's `StorageErrorCode` union so
 * that logs from the two backends stay directly comparable during the migration.
 *
 * These messages name files and paths and are therefore **log-only**. The HTTP
 * layer collapses every one of them into the same opaque `STORAGE_FAILURE`
 * envelope; `docs/contract-freeze.md` makes that non-negotiable, and the
 * `errors.leakNothing` invariant asserts it.
 */
final class StorageException extends \RuntimeException
{
    public const DIRECTORY_FAILED = 'STORAGE_DIRECTORY_FAILED';
    public const FILE_NOT_FOUND = 'STORAGE_FILE_NOT_FOUND';
    public const FILE_TOO_LARGE = 'STORAGE_FILE_TOO_LARGE';
    public const READ_FAILED = 'STORAGE_READ_FAILED';
    public const INVALID_JSON = 'STORAGE_INVALID_JSON';
    public const VALIDATION_FAILED = 'STORAGE_VALIDATION_FAILED';
    public const WRITE_FAILED = 'STORAGE_WRITE_FAILED';
    public const RENAME_FAILED = 'STORAGE_RENAME_FAILED';
    public const REMOVE_FAILED = 'STORAGE_REMOVE_FAILED';
    public const LOCK_FAILED = 'STORAGE_LOCK_FAILED';
    public const CROSS_DEVICE_TMP = 'STORAGE_CROSS_DEVICE_TMP';

    public function __construct(
        public readonly string $storageCode,
        string $message,
        public readonly ?string $fileRole = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    /** @return array<string, string|null> Safe for the log, never for a response. */
    public function logContext(): array
    {
        return ['code' => $this->storageCode, 'fileRole' => $this->fileRole];
    }
}
