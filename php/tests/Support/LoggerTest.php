<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Support\FrozenClock;
use Eszter\Support\Logger;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The log-file permission policy (ESZ-103).
 *
 * The logger's contract is that logging failure can never turn an HTTP request
 * into a 500, so every restriction failure here is asserted as silence, never
 * as an exception — and the other half of the policy is that the silence is
 * chosen *instead of* knowingly writing into a log file whose mode could not
 * be established.
 */
final class LoggerTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-logger');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    private function logger(string $path, ?\Closure $setFileMode = null): Logger
    {
        return new Logger($path, 'debug', new FrozenClock(self::NOW), false, $setFileMode);
    }

    public function testANewLogFileIsBorn0600UnderAHostileUmaskAndRestoresIt(): void
    {
        $path = $this->root . '/app.log';
        $previous = umask(0o000);

        try {
            $this->logger($path)->info('first line');
        } finally {
            umask($previous);
        }

        // fopen('ab') would create at 0666 under the hostile umask; the class
        // restricts the umask around the open, so the file is born and stays at
        // the documented mode, and the process umask is back where it was.
        self::assertSame(Logger::FILE_MODE, fileperms($path) & 0o777);
        self::assertSame($previous, umask(), 'the process umask was not restored');
        self::assertStringContainsString('"message":"first line"', (string) file_get_contents($path));
    }

    public function testAnExistingWiderLogFileIsCorrectedBeforeWritesContinue(): void
    {
        $path = $this->root . '/app.log';
        file_put_contents($path, "older line\n");
        chmod($path, 0o644);

        $this->logger($path)->info('newer line');

        // A pre-existing over-permissive log the application owns is corrected
        // on open, and logging continues only once the mode is verified.
        self::assertSame(Logger::FILE_MODE, fileperms($path) & 0o777);
        $contents = (string) file_get_contents($path);
        self::assertStringContainsString('older line', $contents);
        self::assertStringContainsString('newer line', $contents);
    }

    public function testARestrictionThatCannotBeAppliedSilencesTheLoggerWithoutCrashing(): void
    {
        $path = $this->root . '/app.log';
        file_put_contents($path, "older line\n");
        chmod($path, 0o644);

        $logger = $this->logger($path, static fn (string $path, int $mode): bool => false);

        // No exception: the caller is an HTTP request that must not turn into a
        // 500 because logging failed. And no write either: a log whose
        // restriction cannot be established is not knowingly written wider.
        $logger->info('never written');
        $logger->error('still never written');

        self::assertSame("older line\n", file_get_contents($path));
    }

    public function testAModeClaimThatCannotBeVerifiedSilencesTheLogger(): void
    {
        $path = $this->root . '/app.log';
        file_put_contents($path, "older line\n");
        chmod($path, 0o644);

        // The seam reports success without chmodding — the hard fileperms
        // verification must refuse to keep the stream: a chmod call alone is
        // not proof that the file stopped being wider.
        $logger = $this->logger($path, static fn (string $path, int $mode): bool => true);
        $logger->info('never written');

        self::assertSame("older line\n", file_get_contents($path));
    }

    public function testAnUnopenableLogPathDegradesToSilence(): void
    {
        // `blocker` is a file, so its child cannot be a directory: the log path
        // can never be opened. The logger must stay silent, not raise.
        file_put_contents($this->root . '/blocker', 'x');
        $logger = $this->logger($this->root . '/blocker/app.log');

        $logger->info('nothing to say');
        $logger->error('still nothing to say');

        self::assertFileDoesNotExist($this->root . '/blocker/app.log');
    }
}
