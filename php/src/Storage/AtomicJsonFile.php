<?php

declare(strict_types=1);

namespace Eszter\Storage;

/**
 * Write-or-nothing JSON files.
 *
 * A reader must never observe a half-written document, and a crash mid-write must
 * leave the previous version intact. That needs four steps in order, and skipping
 * any one of them silently reintroduces the failure it prevents:
 *
 *  1. write to a unique temp file in `var/tmp/`;
 *  2. `fflush()` then `fsync()` — without the fsync the rename can land before
 *     the data does, and a power loss leaves an empty file where content was;
 *  3. `chmod` before publishing, so the file is never briefly world-readable;
 *  4. `rename()` onto the target, which POSIX guarantees is atomic *within a
 *     single filesystem*.
 *
 * Step 4 is why `paths.tmp` must sit on the same filesystem as `paths.content`
 * (`docs/hetzner-target-architecture.md` §3, rule 4). {@see ContentStorage} checks
 * that at bootstrap rather than discovering it on the first publish.
 */
final class AtomicJsonFile
{
    public const FILE_MODE = 0o640;

    public function __construct(private readonly string $tmpDirectory)
    {
    }

    /**
     * Serialises $payload and replaces $targetPath with it, atomically.
     *
     * The encoding matches the reference implementation byte for byte —
     * two-space indent, unescaped slashes and UTF-8, trailing newline — so that a
     * file written by either backend is diffable against one written by the other.
     */
    public function write(string $targetPath, mixed $payload, ?string $fileRole = null): void
    {
        $encoded = json_encode(
            $payload,
            JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
        );

        if ($encoded === false) {
            throw new StorageException(
                StorageException::WRITE_FAILED,
                'Content payload could not be encoded as JSON: ' . json_last_error_msg(),
                $fileRole,
            );
        }

        // json_encode indents with four spaces; the reference uses two.
        $encoded = preg_replace_callback(
            '/^ +/m',
            static fn (array $match): string => str_repeat(' ', \intdiv(\strlen($match[0]), 2)),
            $encoded,
        ) ?? $encoded;

        $this->replace($targetPath, $encoded . "\n", $fileRole);
    }

    public function replace(string $targetPath, string $contents, ?string $fileRole = null): void
    {
        $this->ensureDirectory(\dirname($targetPath), $fileRole);
        $this->ensureDirectory($this->tmpDirectory, $fileRole);

        $temporaryPath = \sprintf(
            '%s/.%s.%d.%s.tmp',
            $this->tmpDirectory,
            basename($targetPath),
            getmypid() ?: 0,
            bin2hex(random_bytes(8)),
        );

        $handle = @fopen($temporaryPath, 'xb');

        if ($handle === false) {
            throw new StorageException(
                StorageException::WRITE_FAILED,
                "Could not create temporary file {$temporaryPath}.",
                $fileRole,
            );
        }

        try {
            if (@fwrite($handle, $contents) !== \strlen($contents)) {
                throw new StorageException(
                    StorageException::WRITE_FAILED,
                    "Short write to temporary file {$temporaryPath}.",
                    $fileRole,
                );
            }

            if (!@fflush($handle)) {
                throw new StorageException(
                    StorageException::WRITE_FAILED,
                    "Could not flush temporary file {$temporaryPath}.",
                    $fileRole,
                );
            }

            // Available since PHP 8.1. Without it, `rename` may be durable while
            // the bytes it points at are not.
            if (\function_exists('fsync') && !@fsync($handle)) {
                throw new StorageException(
                    StorageException::WRITE_FAILED,
                    "Could not fsync temporary file {$temporaryPath}.",
                    $fileRole,
                );
            }
        } catch (\Throwable $error) {
            fclose($handle);
            @unlink($temporaryPath);

            throw $error;
        }

        fclose($handle);
        @chmod($temporaryPath, self::FILE_MODE);

        if (!@rename($temporaryPath, $targetPath)) {
            @unlink($temporaryPath);

            throw new StorageException(
                StorageException::RENAME_FAILED,
                "Could not rename {$temporaryPath} onto {$targetPath}. "
                    . 'The temp directory and the content directory must be on the same filesystem.',
                $fileRole,
            );
        }
    }

    private function ensureDirectory(string $directory, ?string $fileRole): void
    {
        if (is_dir($directory)) {
            return;
        }

        if (!@mkdir($directory, 0o770, true) && !is_dir($directory)) {
            throw new StorageException(
                StorageException::DIRECTORY_FAILED,
                "Could not create directory {$directory}.",
                $fileRole,
            );
        }
    }
}
