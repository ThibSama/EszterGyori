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
 *  1. write to a unique temp file in `var/tmp/`, **born** mode 0600 — `fopen()`
 *     applies the process umask (0666 & ~umask), so the umask itself is
 *     restricted around the creation and restored afterwards, and the temp is
 *     never group/world-readable for the write that follows;
 *  2. `fflush()` then `fsync()` — without the fsync the rename can land before
 *     the data does, and a power loss leaves an empty file where content was;
 *  3. `chmod` to `FILE_MODE` and **verify the effective mode** — a restriction
 *     that cannot be applied or verified refuses the publish (the previous
 *     target, if any, is left byte-identical and the temp is removed), because
 *     a `chmod` call alone is not proof that the file stopped being readable;
 *  4. `rename()` onto the target, which POSIX guarantees is atomic *within a
 *     single filesystem*.
 *
 * Step 4 is why `paths.tmp` must sit on the same filesystem as `paths.content`
 * (`docs/hetzner-target-architecture.md` §3, rule 4). {@see ContentStorage} checks
 * that at bootstrap rather than discovering it on the first publish.
 */
final class AtomicJsonFile
{
    /**
     * The one mode an authoritative/private JSON final may carry (ESZ-103):
     * draft, published and the media catalogue are all at most 0640. A rename
     * replaces the target's inode, so a successful write also corrects a
     * pre-existing wider file; a write that cannot restrict its temp refuses
     * instead.
     */
    public const FILE_MODE = 0o640;

    /**
     * @param string $tmpDirectory The directory temp files are staged in; it
     *        must share a filesystem with every target {@see replace()} publishes
     *        onto.
     * @param \Closure(string, int): bool|null $setFileMode Narrowest test seam
     *        for the mode restriction: when provided it replaces **only** the
     *        `chmod(2)` call. Production passes null and gets the real chmod.
     *        The effective-mode verification that follows is never
     *        seam-injectable — a file is published only when `fileperms()`
     *        shows `FILE_MODE` — so a seam can force a refusal but cannot make
     *        an unverified restriction look applied.
     */
    public function __construct(
        private readonly string $tmpDirectory,
        private readonly ?\Closure $setFileMode = null,
    ) {
    }

    /**
     * Serialises $payload and replaces $targetPath with it, atomically.
     *
     * The encoding matches the reference implementation byte for byte —
     * two-space indent, unescaped slashes and UTF-8, trailing newline — so that a
     * file written by either backend is diffable against one written by the other.
     *
     * @param int|null $maxBytes A cap on the encoded document, checked against the
     *        exact bytes that are about to be written and before anything is
     *        created (ESZ-084). It exists for the one file whose size a caller can
     *        actually grow — the media catalogue — where a cap enforced on the
     *        next read instead would only fire once the file had already become
     *        unreadable, taking the delete that could have shrunk it with it. See
     *        `storageLimitReconciliation.enforcedOnWrite`.
     */
    public function write(
        string $targetPath,
        mixed $payload,
        ?string $fileRole = null,
        ?int $maxBytes = null,
    ): void {
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

        $document = $encoded . "\n";

        if ($maxBytes !== null && \strlen($document) > $maxBytes) {
            // Raised before `replace()`, so no temporary file is created and the
            // existing document is left exactly as it was. The refusal has to be
            // a non-event for the file it protects, or it is just a different way
            // to break it.
            throw new StorageException(
                StorageException::FILE_TOO_LARGE,
                \sprintf(
                    'The document would be %d bytes, over the %d byte cap.',
                    \strlen($document),
                    $maxBytes,
                ),
                $fileRole,
            );
        }

        $this->replace($targetPath, $document, $fileRole);
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

        // The temp file must be born restricted, not restricted a moment later:
        // fopen() creates at 0666 & ~umask, so under a permissive process umask
        // the file would be group/world-readable from its first byte onwards.
        // The umask is process-global, so it is restored in `finally` even on
        // an exception. PHP's request model is one process per request and the
        // CLI is single-threaded, so the window is safe.
        $previousUmask = umask(0o077);
        $handle = false;

        try {
            $handle = @fopen($temporaryPath, 'xb');

            if ($handle === false) {
                throw new StorageException(
                    StorageException::WRITE_FAILED,
                    "Could not create temporary file {$temporaryPath}.",
                    $fileRole,
                );
            }

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
            if ($handle !== false) {
                fclose($handle);
            }

            @unlink($temporaryPath);

            throw $error;
        } finally {
            umask($previousUmask);
        }

        fclose($handle);

        // Restrict before publishing, and only publish a restriction that is
        // verified. A chmod that was accepted but did not take effect must not
        // reach the target under the old, wider mode.
        if (!$this->restrict($temporaryPath)) {
            @unlink($temporaryPath);

            throw new StorageException(
                StorageException::WRITE_FAILED,
                \sprintf(
                    'Could not restrict temporary file %s to mode %04o; refusing to publish it.',
                    $temporaryPath,
                    self::FILE_MODE,
                ),
                $fileRole,
            );
        }

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

    /**
     * Applies {@see FILE_MODE} to $path and verifies the effective mode.
     *
     * A `chmod` call alone is not proof: a filesystem or wrapper can accept it
     * and leave the file wider. The restriction only counts when `fileperms()`
     * shows the requested mode, so this returns false both when the mode cannot
     * be applied and when it was applied but did not take effect.
     */
    private function restrict(string $path): bool
    {
        $applied = $this->setFileMode === null
            ? @chmod($path, self::FILE_MODE)
            : ($this->setFileMode)($path, self::FILE_MODE);

        if ($applied !== true) {
            return false;
        }

        $actual = @fileperms($path);

        return $actual !== false && ($actual & 0o777) === self::FILE_MODE;
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
