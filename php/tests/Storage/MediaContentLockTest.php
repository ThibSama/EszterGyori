<?php

declare(strict_types=1);

namespace Eszter\Tests\Storage;

use Eszter\Storage\MediaContentLock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The media/content boundary lock (ESZ-100).
 *
 * {@see \Eszter\Storage\MediaContentLock} serialises media deletion against
 * content writes: the delete takes it exclusively across its whole
 * check-to-commit critical section and every durable content write takes it
 * shared, so a save can never commit a fresh media reference between the
 * delete's reference check and its removal.
 *
 * These tests pin the primitive's process-local semantics; the exclusion
 * itself — exclusive vs shared, in both directions — is asserted with a
 * non-blocking `flock` probe on a second descriptor, exactly as
 * {@see FileLockTest} does for `content.lock`. The end-to-end ordering proofs
 * (save-then-delete and delete-then-save, in real processes) live in
 * {@see \Eszter\Tests\Media\MediaDeleteConcurrencyTest}.
 */
final class MediaContentLockTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-media-content-lock');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testTheLockFileAndItsDirectoryAreCreatedOnDemand(): void
    {
        $lock = new MediaContentLock($this->root . '/locks');

        self::assertSame('ok', $lock->withShared(static fn (): string => 'ok'));

        self::assertFileExists($this->root . '/locks/' . MediaContentLock::FILE_NAME);
    }

    public function testSharedParticipationIsReentrantAcrossInstancesForOneProcess(): void
    {
        $first = new MediaContentLock($this->root . '/locks');
        $second = new MediaContentLock($this->root . '/locks');

        // A delete holds the boundary exclusively and reads content through
        // ContentStorage while holding it; a content write holds it shared and
        // may be entered through a second object on the same directory. The two
        // instances must compose rather than deadlock the process against itself.
        self::assertSame(
            'nested',
            $first->withShared(
                static fn (): string => $second->withShared(static fn (): string => 'nested'),
            ),
        );
    }

    public function testExclusiveDeletionMayReenterThroughAnotherInstance(): void
    {
        $deletion = new MediaContentLock($this->root . '/locks');
        $storage = new MediaContentLock($this->root . '/locks');

        // MediaLibrary::deleteAsset() takes the boundary exclusively; the
        // content-write helper it must never race takes it shared. Exclusive
        // under exclusive is the delete re-entering itself (depth), shared under
        // exclusive is the forbidden upgrade and must stay loud.
        self::assertSame(
            'inside',
            $deletion->withExclusive(
                static fn (): string => $deletion->withExclusive(static fn (): string => 'inside'),
            ),
        );
    }

    public function testSharedContentWriteCannotUpgradeToAnExclusiveDelete(): void
    {
        $content = new MediaContentLock($this->root . '/locks');
        $deletion = new MediaContentLock($this->root . '/locks');

        $this->expectException(\LogicException::class);
        $content->withShared(static fn (): mixed => $deletion->withExclusive(static fn (): null => null));
    }

    public function testAThrowReleasesTheBoundary(): void
    {
        $lock = new MediaContentLock($this->root . '/locks');

        try {
            $lock->withExclusive(static function (): never {
                throw new \RuntimeException('boom');
            });
        } catch (\RuntimeException) {
        }

        self::assertSame('released', $lock->withShared(static fn (): string => 'released'));
    }

    public function testAnExclusiveDeleteExcludesSharedContentWrites(): void
    {
        $path = $this->root . '/locks/' . MediaContentLock::FILE_NAME;
        $lock = new MediaContentLock($this->root . '/locks');

        $sharedGranted = $lock->withExclusive(static function () use ($path): bool {
            $handle = fopen($path, 'c');
            self::assertIsResource($handle);
            $acquired = flock($handle, LOCK_SH | LOCK_NB);

            if ($acquired) {
                flock($handle, LOCK_UN);
            }

            fclose($handle);

            return $acquired;
        });

        self::assertFalse($sharedGranted, 'a shared content write was granted while a delete held the boundary');
    }

    public function testASharedContentWriteExcludesAnExclusiveDelete(): void
    {
        $path = $this->root . '/locks/' . MediaContentLock::FILE_NAME;
        $lock = new MediaContentLock($this->root . '/locks');

        $exclusiveGranted = $lock->withShared(static function () use ($path): bool {
            $handle = fopen($path, 'c');
            self::assertIsResource($handle);
            $acquired = flock($handle, LOCK_EX | LOCK_NB);

            if ($acquired) {
                flock($handle, LOCK_UN);
            }

            fclose($handle);

            return $acquired;
        });

        self::assertFalse($exclusiveGranted, 'a delete was granted while a content write held the boundary');
    }
}
