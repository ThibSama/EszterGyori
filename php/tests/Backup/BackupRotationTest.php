<?php

declare(strict_types=1);

namespace Eszter\Tests\Backup;

use Eszter\Backup\BackupException;
use Eszter\Backup\BackupRotation;
use Eszter\Retention\RetentionPolicy;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

final class BackupRotationTest extends TestCase
{
    /** 30 days after the boundary archive below, to the second. */
    private const NOW = '2026-06-13T03:30:00.000Z';

    private string $root;
    private RetentionPolicy $policy;
    private BackupRotation $rotation;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-backup-rotation');
        $this->policy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());
        $this->rotation = new BackupRotation($this->policy, new FrozenClock(self::NOW));
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testExpiredCanonicalArchivesGoAndTheBoundaryAndUnrelatedNamesStay(): void
    {
        self::assertSame(30, $this->policy->backupArchiveRetentionDays);

        $published = $this->file('eszter-backup-20260613-033000.tar.gz');
        $inside = $this->file('eszter-backup-20260514-033001.tar.gz');
        $boundary = $this->file('eszter-backup-20260514-033000.tar.gz');
        $expired = $this->file('eszter-backup-20260514-032959.tar.gz');
        $older = $this->file('eszter-backup-20250101-000000.tar.gz');
        $unrelated = [
            $this->file('eszter-backup-20250101-000000.tar.gz.partial'),
            $this->file('eszter-backup-20250101-000000.tar.gz.bak'),
            $this->file('copy-eszter-backup-20250101-000000.tar.gz'),
            $this->file('eszter-backup-20250231-000000.tar.gz'),
            $this->file('other-20250101-000000.tar.gz'),
        ];

        $result = $this->rotation->run($this->root . '/', $published);

        self::assertSame(['deleted' => [$older, $expired], 'retentionDays' => 30], $result);
        self::assertFileExists($published);
        self::assertFileExists($inside);
        self::assertFileExists($boundary);
        self::assertFileDoesNotExist($expired);
        self::assertFileDoesNotExist($older);
        foreach ($unrelated as $path) {
            self::assertFileExists($path);
        }

        self::assertSame(
            ['deleted' => [], 'retentionDays' => 30],
            $this->rotation->run($this->root, $published),
        );
    }

    public function testASubSecondClockStillKeepsTheWholeSecondBoundary(): void
    {
        $rotation = new BackupRotation($this->policy, new FrozenClock('2026-06-13T03:30:00.750Z'));
        $published = $this->file('eszter-backup-20260613-033000.tar.gz');
        $boundary = $this->file('eszter-backup-20260514-033000.tar.gz');
        $expired = $this->file('eszter-backup-20260514-032959.tar.gz');

        self::assertSame(['deleted' => [$expired], 'retentionDays' => 30], $rotation->run($this->root, $published));
        self::assertFileExists($boundary);
        self::assertFileDoesNotExist($expired);
    }

    public function testSymlinkedCanonicalNameRefusesBeforeAnyDeletion(): void
    {
        $published = $this->file('eszter-backup-20260613-033000.tar.gz');
        $expired = $this->file('eszter-backup-20250101-000000.tar.gz');
        $outside = $this->file('outside.tar.gz');
        symlink($outside, $this->root . '/eszter-backup-20250102-000000.tar.gz');

        try {
            $this->rotation->run($this->root, $published);
            self::fail('a symlinked canonical archive name was accepted');
        } catch (BackupException $exception) {
            self::assertSame(
                "Refusing to rotate a symlinked archive name: {$this->root}/eszter-backup-20250102-000000.tar.gz",
                $exception->getMessage(),
            );
        }

        self::assertFileExists($expired);
        self::assertFileExists($outside);
        self::assertFileExists($published);
    }

    public function testNonRegularCanonicalNameRefusesBeforeAnyDeletion(): void
    {
        $published = $this->file('eszter-backup-20260613-033000.tar.gz');
        $expired = $this->file('eszter-backup-20250101-000000.tar.gz');
        mkdir($this->root . '/eszter-backup-20250103-000000.tar.gz');

        try {
            $this->rotation->run($this->root, $published);
            self::fail('a directory at a canonical archive name was accepted');
        } catch (BackupException $exception) {
            self::assertStringStartsWith('Refusing to rotate a non-regular archive name: ', $exception->getMessage());
        }

        self::assertFileExists($expired);
    }

    public function testAFailedBackupCannotPrune(): void
    {
        $expired = $this->file('eszter-backup-20250101-000000.tar.gz');
        $partial = $this->file('eszter-backup-20260613-033000.tar.gz.partial');
        $missing = $this->root . '/eszter-backup-20260613-033000.tar.gz';

        foreach ([$missing, $partial, $expired . '.bak', $this->root . '/other/' . basename($missing)] as $claimed) {
            try {
                $this->rotation->run($this->root, $claimed);
                self::fail("rotation ran without a published archive: {$claimed}");
            } catch (BackupException $exception) {
                self::assertStringStartsWith(
                    "Refusing to rotate: no published archive at {$claimed}.",
                    $exception->getMessage(),
                );
            }
        }

        // A published name that is itself a symlink is not a publish either.
        symlink($expired, $missing);
        try {
            $this->rotation->run($this->root, $missing);
            self::fail('a symlinked published archive was accepted');
        } catch (BackupException $exception) {
            self::assertStringStartsWith('Refusing to rotate: no published archive at ', $exception->getMessage());
        }

        self::assertFileExists($expired);
        self::assertFileExists($partial);
    }

    private function file(string $name): string
    {
        $path = $this->root . '/' . $name;
        file_put_contents($path, $name);

        return $path;
    }
}
