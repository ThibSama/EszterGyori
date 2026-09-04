<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * The narrow filesystem policy shared by request logging and production preflight.
 *
 * This is deliberately only a log sink, not a general filesystem abstraction:
 * it creates the configured parent, opens append-only, establishes and verifies
 * {@see Logger::FILE_MODE}, and can prove one complete, flushed probe write.
 */
final class LogSink
{
    public const DIRECTORY_FAILURE = 'log directory is not creatable.';
    public const OPEN_FAILURE = 'log file is not openable in append mode.';
    public const MODE_FAILURE = 'log file cannot be restricted to mode 0600.';
    public const WRITE_FAILURE = 'log probe write was not fully flushed.';

    /**
     * @param \Closure(string, int): bool|null $setFileMode Replaces only chmod(2) in tests.
     * @param (\Closure(resource, string): (int|false))|null $write Replaces only fwrite(2) in tests.
     */
    public function __construct(
        private readonly string $filePath,
        private readonly ?\Closure $setFileMode = null,
        private readonly ?\Closure $write = null,
    ) {
    }

    /**
     * @return array{handle: resource|null, failure: string|null}
     */
    public function open(): array
    {
        $directory = \dirname($this->filePath);

        try {
            if (!is_dir($directory) && !@mkdir($directory, 0o770, true) && !is_dir($directory)) {
                return ['handle' => null, 'failure' => self::DIRECTORY_FAILURE];
            }
        } catch (\Throwable) {
            return ['handle' => null, 'failure' => self::DIRECTORY_FAILURE];
        }

        $previousUmask = umask(0o077);

        try {
            $handle = @fopen($this->filePath, 'ab');
        } catch (\Throwable) {
            $handle = false;
        } finally {
            umask($previousUmask);
        }

        if ($handle === false) {
            return ['handle' => null, 'failure' => self::OPEN_FAILURE];
        }

        try {
            $applied = $this->setFileMode === null
                ? @chmod($this->filePath, Logger::FILE_MODE)
                : ($this->setFileMode)($this->filePath, Logger::FILE_MODE);
            $actual = @fileperms($this->filePath);
        } catch (\Throwable) {
            $applied = false;
            $actual = false;
        }

        if ($applied !== true || $actual === false || ($actual & 0o777) !== Logger::FILE_MODE) {
            fclose($handle);

            return ['handle' => null, 'failure' => self::MODE_FAILURE];
        }

        return ['handle' => $handle, 'failure' => null];
    }

    /**
     * Writes one context-free JSON line and proves the whole line reached the stream buffer.
     *
     * A passing call intentionally leaves that line in the configured application log.
     * The returned failure is a fixed component verdict, never raw filesystem detail.
     */
    public function probe(Clock $clock): ?string
    {
        $opened = $this->open();
        $handle = $opened['handle'];

        if ($handle === null) {
            return $opened['failure'];
        }

        try {
            $encoded = json_encode(
                [
                    'ts' => $clock->nowIso(),
                    'level' => 'info',
                    'message' => 'preflight:production probe',
                ],
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR,
            );

            if ($encoded === false) {
                return self::WRITE_FAILURE;
            }

            $line = $encoded . "\n";
            $written = $this->write === null
                ? @fwrite($handle, $line)
                : ($this->write)($handle, $line);

            if ($written !== \strlen($line) || !@fflush($handle)) {
                return self::WRITE_FAILURE;
            }
        } catch (\Throwable) {
            return self::WRITE_FAILURE;
        } finally {
            fclose($handle);
        }

        return null;
    }
}
