<?php

declare(strict_types=1);

namespace Eszter\Tests\Backup;

use Eszter\Backup\BackupException;
use Eszter\Backup\BackupSet;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class BackupSetTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-backup-set');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testTheDeclaredFilesystemPrefixesHaveNoLogMember(): void
    {
        $declared = [
            BackupSet::CONTENT_PREFIX,
            BackupSet::ORIGINALS_PREFIX,
            BackupSet::DERIVATIVES_PREFIX,
            BackupSet::DATABASE_FILE,
            BackupSet::MANIFEST_FILE,
        ];

        foreach ($declared as $entry) {
            self::assertStringNotContainsString('log', strtolower($entry));
        }

        BackupSet::assertLogDirectoryExcluded(
            '/srv/eszter/var/log',
            '/srv/eszter/media-originals',
            '/srv/public/media',
        );
        self::addToAssertionCount(1);
    }

    /** @return iterable<string, array{string, string}> */
    public static function unsafeTopologies(): iterable
    {
        yield 'equal to originals' => ['/srv/eszter/media-originals', '/srv/eszter/media-originals'];
        yield 'below originals' => ['/srv/eszter/media-originals/logs', '/srv/eszter/media-originals'];
        yield 'equal to derivatives' => ['/srv/public/media', '/srv/public/media'];
        yield 'below derivatives' => ['/srv/public/media/logs', '/srv/public/media'];
    }

    #[DataProvider('unsafeTopologies')]
    public function testBackupRefusesALogDirectoryThatTheMediaWalkCouldInclude(
        string $logDir,
        string $mediaDir,
    ): void {
        $this->expectException(BackupException::class);
        $this->expectExceptionMessage(BackupSet::UNSAFE_LOG_TOPOLOGY);

        BackupSet::assertLogDirectoryExcluded($logDir, $mediaDir);
    }

    public function testBackupRefusesAResolvedLogAliasInsideWalkedMedia(): void
    {
        mkdir($this->root . '/media');
        mkdir($this->root . '/media/logs');
        symlink($this->root . '/media/logs', $this->root . '/log-alias');

        $this->expectException(BackupException::class);
        $this->expectExceptionMessage(BackupSet::UNSAFE_LOG_TOPOLOGY);

        BackupSet::assertLogDirectoryExcluded($this->root . '/log-alias', $this->root . '/media');
    }
}
