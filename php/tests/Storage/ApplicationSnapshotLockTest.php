<?php

declare(strict_types=1);

namespace Eszter\Tests\Storage;

use Eszter\Storage\ApplicationSnapshotLock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

final class ApplicationSnapshotLockTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-snapshot-lock');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testSharedParticipationIsReentrantAcrossInstancesForOneProcess(): void
    {
        $first = new ApplicationSnapshotLock($this->root . '/locks');
        $second = new ApplicationSnapshotLock($this->root . '/locks');

        $result = $first->withShared(
            static fn (): string => $second->withShared(static fn (): string => 'nested'),
        );

        self::assertSame('nested', $result);
    }

    public function testExclusiveBackupMayEnterSharedDatabaseHelpersWithoutReacquiring(): void
    {
        $backup = new ApplicationSnapshotLock($this->root . '/locks');
        $mutation = new ApplicationSnapshotLock($this->root . '/locks');

        self::assertSame(
            'inside',
            $backup->withExclusive(
                static fn (): string => $mutation->withShared(static fn (): string => 'inside'),
            ),
        );
    }

    public function testSharedMutationCannotUpgradeToAnExclusiveBackup(): void
    {
        $mutation = new ApplicationSnapshotLock($this->root . '/locks');
        $backup = new ApplicationSnapshotLock($this->root . '/locks');

        $this->expectException(\LogicException::class);
        $mutation->withShared(static fn (): mixed => $backup->withExclusive(static fn (): null => null));
    }

    public function testAThrowReleasesTheBarrier(): void
    {
        $lock = new ApplicationSnapshotLock($this->root . '/locks');

        try {
            $lock->withExclusive(static function (): never {
                throw new \RuntimeException('boom');
            });
        } catch (\RuntimeException) {
        }

        self::assertSame('released', $lock->withShared(static fn (): string => 'released'));
    }
}
