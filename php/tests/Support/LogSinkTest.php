<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Support\FrozenClock;
use Eszter\Support\Logger;
use Eszter\Support\LogSink;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/** Fail-closed proofs for the host-side log-sink preflight (ESZ-128). */
final class LogSinkTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-log-sink');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testHealthyPrivateTargetPassesAndLeavesOneValidProbeLine(): void
    {
        $path = $this->root . '/nested/app.log';
        $originalUmask = umask(0o000);

        try {
            $failure = $this->sink($path)->probe($this->clock());
            $restoredUmask = umask(0o000);
        } finally {
            umask($originalUmask);
        }

        self::assertNull($failure);
        self::assertSame(0o000, $restoredUmask);
        self::assertFileExists($path);
        self::assertSame(Logger::FILE_MODE, fileperms($path) & 0o777);
        $line = json_decode(trim((string) file_get_contents($path)), true, 512, JSON_THROW_ON_ERROR);
        self::assertSame([
            'ts' => self::NOW,
            'level' => 'info',
            'message' => 'preflight:production probe',
        ], $line);
    }

    public function testBlockedParentSilencesLoggerAndFailsDirectoryPreflight(): void
    {
        file_put_contents($this->root . '/blocker', 'unchanged');
        $path = $this->root . '/blocker/app.log';
        $logger = $this->logger($path);

        $logger->info('not written');
        $logger->error('still not written');
        $failure = $this->sink($path)->probe($this->clock());

        self::assertSame(LogSink::DIRECTORY_FAILURE, $failure);
        self::assertSame('unchanged', file_get_contents($this->root . '/blocker'));
        self::assertFileDoesNotExist($path);
    }

    public function testRejectedModeSilencesLoggerAndFailsModePreflight(): void
    {
        $path = $this->root . '/mode.log';
        file_put_contents($path, "older line\n");
        chmod($path, 0o644);
        $reject = static fn (string $path, int $mode): bool => false;

        $this->logger($path, $reject)->info('not written');
        $failure = $this->sink($path, $reject)->probe($this->clock());

        self::assertSame(LogSink::MODE_FAILURE, $failure);
        self::assertSame("older line\n", file_get_contents($path));
        self::assertSame(0o644, fileperms($path) & 0o777);
    }

    public function testLyingModeSeamCannotBypassEffectivePermissionVerification(): void
    {
        $path = $this->root . '/lying-mode.log';
        file_put_contents($path, "older line\n");
        chmod($path, 0o644);
        $lies = static fn (string $path, int $mode): bool => true;

        $failure = $this->sink($path, $lies)->probe($this->clock());

        self::assertSame(LogSink::MODE_FAILURE, $failure);
        self::assertSame("older line\n", file_get_contents($path));
        self::assertSame(0o644, fileperms($path) & 0o777);
    }

    public function testShortWriteSilencesLoggerAndFailsWritePreflight(): void
    {
        $loggerPath = $this->root . '/logger-short.log';
        $probePath = $this->root . '/probe-short.log';
        $short = static fn ($stream, string $line): int => \strlen($line) - 1;

        $this->logger($loggerPath, null, $short)->info('not written');
        $failure = $this->sink($probePath, null, $short)->probe($this->clock());

        self::assertSame(LogSink::WRITE_FAILURE, $failure);
        self::assertSame('', file_get_contents($loggerPath));
        self::assertSame('', file_get_contents($probePath));
        self::assertSame(Logger::FILE_MODE, fileperms($loggerPath) & 0o777);
        self::assertSame(Logger::FILE_MODE, fileperms($probePath) & 0o777);
    }

    /**
     * @param \Closure(string, int): bool|null $setFileMode
     * @param (\Closure(resource, string): (int|false))|null $write
     */
    private function logger(
        string $path,
        ?\Closure $setFileMode = null,
        ?\Closure $write = null,
    ): Logger {
        return new Logger($path, 'debug', $this->clock(), false, $setFileMode, $write);
    }

    /**
     * @param \Closure(string, int): bool|null $setFileMode
     * @param (\Closure(resource, string): (int|false))|null $write
     */
    private function sink(
        string $path,
        ?\Closure $setFileMode = null,
        ?\Closure $write = null,
    ): LogSink {
        return new LogSink($path, $setFileMode, $write);
    }

    private function clock(): FrozenClock
    {
        return new FrozenClock(self::NOW);
    }
}
