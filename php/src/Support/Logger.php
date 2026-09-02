<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * Structured JSON-lines logger.
 *
 * One line per event, machine-greppable, appended to a file outside the document
 * root. Diagnostics live here and only here: the HTTP layer answers with opaque
 * envelopes (`docs/contract-freeze.md`, "Storage failures"), so this file is the
 * only place a filesystem path or a validation issue is allowed to appear.
 *
 * ## Log-file mode policy (ESZ-103)
 *
 * The log file is created — or, when it already exists, corrected — to mode
 * 0600, and that restriction is verified before any line is written to it. A
 * new file is born 0600 (the process umask is restricted around the `fopen`
 * and restored immediately), so it is never group/world-readable for the write
 * that follows. A log file whose mode cannot be established is not written to:
 * the logger degrades to silence for it rather than knowingly writing into a
 * wider file. That is the same silence the class already uses for an
 * unopenable log path — logging must never be the reason a request fails, so
 * no failure here escapes to the caller.
 */
final class Logger
{
    public const LEVELS = ['debug' => 10, 'info' => 20, 'warn' => 30, 'error' => 40];

    /**
     * The one mode a log file may carry (ESZ-103): diagnostics name filesystem
     * paths and validation issues, so the log is private to the application
     * user at 0600, like the other non-public artifacts.
     */
    public const FILE_MODE = 0o600;

    private int $threshold;

    /** @var resource|null */
    private mixed $stream = null;

    /**
     * @param \Closure(string, int): bool|null $setFileMode Narrowest test seam
     *        for the log-file mode correction: when provided it replaces **only**
     *        the `chmod(2)` call. Production passes null and gets the real
     *        chmod. The effective-mode verification that follows is never
     *        seam-injectable — a stream is only kept when `fileperms()` shows
     *        {@see FILE_MODE} — so a seam can force the silence path but cannot
     *        make an unverified restriction look applied.
     */
    public function __construct(
        private readonly string $filePath,
        string $level,
        private readonly Clock $clock,
        private readonly bool $alsoStderr = false,
        private readonly ?\Closure $setFileMode = null,
    ) {
        $this->threshold = self::LEVELS[$level] ?? self::LEVELS['info'];
    }

    /** @param array<string, mixed> $context */
    public function debug(string $message, array $context = []): void
    {
        $this->log('debug', $message, $context);
    }

    /** @param array<string, mixed> $context */
    public function info(string $message, array $context = []): void
    {
        $this->log('info', $message, $context);
    }

    /** @param array<string, mixed> $context */
    public function warn(string $message, array $context = []): void
    {
        $this->log('warn', $message, $context);
    }

    /** @param array<string, mixed> $context */
    public function error(string $message, array $context = []): void
    {
        $this->log('error', $message, $context);
    }

    /** @param array<string, mixed> $context */
    public function log(string $level, string $message, array $context = []): void
    {
        if ((self::LEVELS[$level] ?? 0) < $this->threshold) {
            return;
        }

        $line = json_encode(
            ['ts' => $this->clock->nowIso(), 'level' => $level, 'message' => $message] + $context,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR,
        );

        if ($line === false) {
            return;
        }

        $this->write($line . "\n");
    }

    private function write(string $line): void
    {
        if ($this->alsoStderr) {
            file_put_contents('php://stderr', $line);
        }

        if ($this->stream === null && !$this->open()) {
            return;
        }

        $stream = $this->stream;

        if ($stream === null) {
            return;
        }

        @fwrite($stream, $line);
    }

    /**
     * Opens the log file and establishes {@see FILE_MODE} on it.
     *
     * A new file must be born 0600, not chmodded to it after the fact: fopen()
     * creates at 0666 & ~umask, so under a permissive process umask the log
     * would be group/world-readable from its first line onwards. The umask is
     * process-global, so it is restricted only around the open and restored
     * immediately after. An existing file is corrected to 0600 whenever the
     * application owns it; when the mode cannot be applied — or was applied but
     * did not take effect — the handle is closed and no stream is kept, so no
     * line is knowingly written into a wider file. Both failures degrade to
     * silence, never to an exception: logging must not be the reason a request
     * fails.
     */
    private function open(): bool
    {
        $directory = \dirname($this->filePath);
        if (!is_dir($directory) && !@mkdir($directory, 0o770, true) && !is_dir($directory)) {
            return false;
        }

        $previousUmask = umask(0o077);

        try {
            $handle = @fopen($this->filePath, 'ab');
        } finally {
            umask($previousUmask);
        }

        if ($handle === false) {
            // Logging must never be the reason a request fails. A host that
            // denies the log path degrades to silence, not to a 500.
            return false;
        }

        $applied = $this->setFileMode === null
            ? @chmod($this->filePath, self::FILE_MODE)
            : ($this->setFileMode)($this->filePath, self::FILE_MODE);

        $actual = @fileperms($this->filePath);

        if ($applied !== true || $actual === false || ($actual & 0o777) !== self::FILE_MODE) {
            fclose($handle);

            return false;
        }

        $this->stream = $handle;

        return true;
    }
}
