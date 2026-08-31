<?php

declare(strict_types=1);

namespace Eszter\Tests\Storage;

use Eszter\Storage\FileLock;
use Eszter\Storage\StorageException;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

final class FileLockTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-lock');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testTheLockFileAndItsDirectoryAreCreatedOnDemand(): void
    {
        $path = $this->root . '/locks/content.lock';

        self::assertSame('ok', (new FileLock($path))->withLock(true, static fn (): string => 'ok'));
        self::assertFileExists($path);
    }

    public function testTheLockIsReleasedWhenTheOperationThrows(): void
    {
        $lock = new FileLock($this->root . '/locks/content.lock');

        try {
            $lock->withLock(true, static function (): never {
                throw new \RuntimeException('boom');
            });
        } catch (\RuntimeException) {
            // expected
        }

        // A lock leaked by a failed publish would deadlock every later request,
        // which on shared hosting means the site stays down until someone notices.
        self::assertSame('reacquired', $lock->withLock(true, static fn (): string => 'reacquired'));
    }

    public function testAnUncreatableLockDirectoryIsAStorageFailure(): void
    {
        $blocker = $this->root . '/blocked';
        file_put_contents($blocker, 'not a directory');

        $this->expectException(StorageException::class);

        (new FileLock($blocker . '/content.lock'))->withLock(true, static fn (): bool => true);
    }

    public function testAnExclusiveLockExcludesAnotherProcess(): void
    {
        $path = $this->root . '/locks/content.lock';
        $lock = new FileLock($path);

        $observed = $lock->withLock(true, static function () use ($path): bool {
            // A second handle in this process would be granted the lock again
            // (flock is per file handle, and re-locking the same handle succeeds),
            // so the contention is checked with a non-blocking probe on a fresh one.
            $handle = fopen($path, 'c');
            self::assertIsResource($handle);
            $acquired = flock($handle, LOCK_EX | LOCK_NB);

            if ($acquired) {
                flock($handle, LOCK_UN);
            }

            fclose($handle);

            return $acquired;
        });

        self::assertFalse($observed, 'a second exclusive lock was granted while one was held');
    }
}
