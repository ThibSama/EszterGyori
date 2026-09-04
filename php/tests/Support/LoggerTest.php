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

    private function logger(
        string $path,
        ?\Closure $setFileMode = null,
        ?\Closure $write = null,
        string $level = 'debug',
    ): Logger {
        return new Logger($path, $level, new FrozenClock(self::NOW), false, $setFileMode, $write);
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

    public function testFailedAndShortWritesNeverEscapeOrWriteAFalseSuccess(): void
    {
        $failedPath = $this->root . '/failed.log';
        $shortPath = $this->root . '/short.log';

        $this->logger(
            $failedPath,
            null,
            static fn ($stream, string $line): false => false,
        )->info('failed write');
        $this->logger(
            $shortPath,
            null,
            static fn ($stream, string $line): int => \strlen($line) - 1,
        )->error('short write');

        self::assertSame('', file_get_contents($failedPath));
        self::assertSame('', file_get_contents($shortPath));
    }

    public function testPartialJsonValuesStayValidAndDoNotCrashLogging(): void
    {
        $path = $this->root . '/partial.log';
        $resource = fopen('php://memory', 'rb');
        self::assertIsResource($resource);
        $circular = [];
        $circular['self'] = &$circular;

        try {
            $this->logger($path)->info('resource', ['problem' => $resource]);
            $this->logger($path)->info('circular', ['problem' => $circular]);
        } finally {
            fclose($resource);
        }

        $lines = $this->decodedLines($path);
        self::assertCount(2, $lines);
        self::assertNull($lines[0]['problem']);
        self::assertIsArray($lines[1]['problem']);
        self::assertNull($lines[1]['problem']['self']);
    }

    public function testThrowingJsonSerializableDropsContextWithoutLeakingOrCrashing(): void
    {
        $path = $this->root . '/throwing-context.log';
        $context = new class implements \JsonSerializable {
            public function jsonSerialize(): mixed
            {
                throw new \RuntimeException('raw-sensitive-exception-detail');
            }
        };

        $this->logger($path)->error('safe message', [
            'unsafe' => $context,
            'secret' => 'must-be-dropped-with-context',
        ]);

        $contents = (string) file_get_contents($path);
        $lines = $this->decodedLines($path);
        self::assertCount(1, $lines);
        self::assertSame([
            'ts' => self::NOW,
            'level' => 'error',
            'message' => 'safe message',
        ], $lines[0]);
        self::assertStringNotContainsString('raw-sensitive-exception-detail', $contents);
        self::assertStringNotContainsString('must-be-dropped-with-context', $contents);
        self::assertStringNotContainsString('JsonSerializable', $contents);
    }

    public function testContextCannotOverrideEnvelopeButIntentionalStringContextIsPreserved(): void
    {
        $path = $this->root . '/context.log';
        $this->logger($path)->warn('authoritative message', [
            'ts' => 'forged timestamp',
            'level' => 'debug',
            'message' => 'forged message',
            'customer_note' => 'intentional sensitive string',
        ]);

        $line = $this->decodedLines($path)[0];
        self::assertSame(self::NOW, $line['ts']);
        self::assertSame('warn', $line['level']);
        self::assertSame('authoritative message', $line['message']);
        self::assertSame('intentional sensitive string', $line['customer_note']);
    }

    public function testHealthyWarnLoggerWritesStrictJsonLinesFiltersAndRestoresUmask(): void
    {
        $path = $this->root . '/healthy.jsonl';
        $originalUmask = umask(0o000);

        try {
            $logger = $this->logger($path, null, null, 'warn');
            $logger->debug('skip debug');
            $logger->info('skip info');
            $logger->warn('keep warn', ['attempt' => 1]);
            $logger->error('keep error', ['attempt' => 2]);
            $restoredUmask = umask(0o000);
        } finally {
            umask($originalUmask);
        }

        self::assertSame(0o000, $restoredUmask);
        self::assertSame(Logger::FILE_MODE, fileperms($path) & 0o777);
        $lines = $this->decodedLines($path);
        self::assertCount(2, $lines);
        self::assertSame(['warn', 'error'], array_column($lines, 'level'));

        foreach ($lines as $line) {
            self::assertIsString($line['ts']);
            self::assertIsString($line['level']);
            self::assertIsString($line['message']);
        }
    }

    /** @return list<array<string, mixed>> */
    private function decodedLines(string $path): array
    {
        $contents = rtrim((string) file_get_contents($path), "\n");

        return array_map(
            static function (string $line): array {
                /** @var array<string, mixed> $decoded */
                $decoded = json_decode($line, true, 512, JSON_THROW_ON_ERROR);

                return $decoded;
            },
            explode("\n", $contents),
        );
    }
}
