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
 */
final class Logger
{
    public const LEVELS = ['debug' => 10, 'info' => 20, 'warn' => 30, 'error' => 40];

    private int $threshold;

    /** @var resource|null */
    private mixed $stream = null;

    public function __construct(
        private readonly string $filePath,
        string $level,
        private readonly Clock $clock,
        private readonly bool $alsoStderr = false,
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

        if ($this->stream === null) {
            $directory = \dirname($this->filePath);
            if (!is_dir($directory) && !@mkdir($directory, 0o770, true) && !is_dir($directory)) {
                return;
            }

            $handle = @fopen($this->filePath, 'ab');
            if ($handle === false) {
                // Logging must never be the reason a request fails. A host that
                // denies the log path degrades to silence, not to a 500.
                return;
            }

            $this->stream = $handle;
        }

        @fwrite($this->stream, $line);
    }
}
