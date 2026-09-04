<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Support\FrozenClock;
use Eszter\Support\LogMaintenance;
use Eszter\Support\LogMaintenanceException;
use Eszter\Support\Logger;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

final class LogMaintenanceTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;
    private FrozenClock $clock;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-log-maintenance');
        $this->clock = new FrozenClock(self::NOW);
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testRotationRetentionBoundaryPermissionsAndLoggerRecovery(): void
    {
        $active = $this->file('app.log', "active\n", '2026-06-13', 0o644);
        $inside = $this->file('app.log.20260515', 'inside', null, 0o644);
        $boundary = $this->file('notifications.log.20260514', 'boundary', null, 0o640);
        $expired = $this->file('retention.log.20260513', 'expired', null, 0o644);
        $unrelated = $this->file('notification-cron.log', 'unrelated', null, 0o644);

        $result = (new LogMaintenance($this->root, $this->clock))->run();
        $archive = $this->root . '/app.log.20260613';

        self::assertSame([$archive], $result['rotated']);
        self::assertSame([$expired], $result['deleted']);
        self::assertFileDoesNotExist($active);
        self::assertFileExists($inside);
        self::assertFileExists($boundary);
        self::assertFileExists($archive);
        self::assertSame(0o600, fileperms($inside) & 0o777);
        self::assertSame(0o600, fileperms($boundary) & 0o777);
        self::assertSame(0o600, fileperms($archive) & 0o777);
        self::assertSame('unrelated', file_get_contents($unrelated));
        self::assertSame(0o644, fileperms($unrelated) & 0o777);

        $previous = umask(0o000);
        try {
            (new Logger($active, 'info', $this->clock))->info('after maintenance');
        } finally {
            umask($previous);
        }
        self::assertSame($previous, umask());
        self::assertSame(0o600, fileperms($active) & 0o777);
        self::assertStringContainsString('after maintenance', (string) file_get_contents($active));
        touch($active, (new \DateTimeImmutable('2026-06-13T12:00:00Z'))->getTimestamp());

        $second = (new LogMaintenance($this->root, $this->clock))->run();
        self::assertSame(['rotated' => [], 'deleted' => []], $second);
        self::assertFileExists($active);
        self::assertStringContainsString('after maintenance', (string) file_get_contents($active));
    }

    public function testMissingDirectoryAndNoLogsAreIdempotentNoOps(): void
    {
        $missing = $this->root . '/missing';
        self::assertSame(
            ['rotated' => [], 'deleted' => []],
            (new LogMaintenance($missing, $this->clock))->run(),
        );
        self::assertSame(
            ['rotated' => [], 'deleted' => []],
            (new LogMaintenance($this->root, $this->clock))->run(),
        );
    }

    public function testSymlinkedActiveTargetRefusesBeforeCleanupAndLeavesUnrelatedFilesUntouched(): void
    {
        $target = $this->file('outside.log', 'outside');
        $expired = $this->file('notifications.log.20200101', 'expired');
        $unrelated = $this->file('custom.log.20200101', 'unrelated');
        symlink($target, $this->root . '/app.log');

        try {
            (new LogMaintenance($this->root, $this->clock))->run();
            self::fail('a symlinked active log was accepted');
        } catch (LogMaintenanceException $exception) {
            self::assertSame("refusing symlink target {$this->root}/app.log", $exception->getMessage());
        }

        self::assertSame('outside', file_get_contents($target));
        self::assertSame('expired', file_get_contents($expired));
        self::assertSame('unrelated', file_get_contents($unrelated));
    }

    public function testSymlinkedManagedArchiveIsRefused(): void
    {
        $target = $this->file('outside.log', 'outside');
        symlink($target, $this->root . '/app.log.20260101');

        $this->expectException(LogMaintenanceException::class);
        $this->expectExceptionMessage("refusing symlink target {$this->root}/app.log.20260101");
        (new LogMaintenance($this->root, $this->clock))->run();
    }

    public function testNonRegularActiveTargetRefusesBeforeExpiredArchiveDeletion(): void
    {
        mkdir($this->root . '/app.log');
        $expired = $this->file('retention.log.20200101', 'expired');

        try {
            (new LogMaintenance($this->root, $this->clock))->run();
            self::fail('a directory at an active log name was accepted');
        } catch (LogMaintenanceException $exception) {
            self::assertSame("refusing non-regular target {$this->root}/app.log", $exception->getMessage());
        }

        self::assertSame('expired', file_get_contents($expired));
    }

    private function file(
        string $name,
        string $contents,
        ?string $mtime = null,
        int $mode = 0o600,
    ): string {
        $path = $this->root . '/' . $name;
        file_put_contents($path, $contents);
        chmod($path, $mode);
        if ($mtime !== null) {
            touch($path, (new \DateTimeImmutable($mtime . 'T12:00:00Z'))->getTimestamp());
        }

        return $path;
    }
}
