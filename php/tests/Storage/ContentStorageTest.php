<?php

declare(strict_types=1);

namespace Eszter\Tests\Storage;

use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifacts;
use Eszter\Storage\ContentStorage;
use Eszter\Storage\StorageException;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-012.
 *
 * The decision under test is **strict fail-fast**: content that exists but
 * cannot be validated stops the service. The tempting alternative — reseed from
 * defaults and carry on — silently discards an editor's work and reports success,
 * which is the one outcome this project cannot afford.
 */
final class ContentStorageTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-storage');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    private function storage(): ContentStorage
    {
        $artifacts = TestEnvironment::artifacts();

        return new ContentStorage(
            $this->root . '/data/content',
            $this->root . '/var/tmp',
            $this->root . '/data/locks',
            $artifacts,
            ContentValidator::create($artifacts),
            new FrozenClock(self::NOW),
        );
    }

    public function testInitializeSeedsBothFilesFromTheCanonicalDefaults(): void
    {
        $storage = $this->storage();
        $status = $storage->initialize();

        self::assertSame(
            [ContentStorage::ROLE_DRAFT => 'created', ContentStorage::ROLE_PUBLISHED => 'created'],
            $status,
        );

        $published = $storage->readPublished();
        self::assertSame(1, $published['schemaVersion']);
        self::assertSame(0, $published['revision']);
        self::assertSame(self::NOW, $published['publishedAt']);
        self::assertSame(
            TestEnvironment::artifacts()->canonicalSiteContent(),
            $published['content'],
        );

        $draft = $storage->readDraft();
        self::assertSame(self::NOW, $draft['updatedAt']);
        self::assertArrayNotHasKey('publishedAt', $draft);
    }

    public function testInitializeIsIdempotentAndNeverOverwrites(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        $envelope = $storage->readPublished();
        $envelope['revision'] = 12;
        $envelope['content']['hero']['badgeLabel'] = 'Edited';
        $storage->writePublished($envelope);

        $status = $storage->initialize();

        self::assertSame(
            [ContentStorage::ROLE_DRAFT => 'validated', ContentStorage::ROLE_PUBLISHED => 'validated'],
            $status,
        );

        $reread = $storage->readPublished();
        self::assertSame(12, $reread['revision']);
        self::assertSame('Edited', $reread['content']['hero']['badgeLabel']);
    }

    public function testAMalformedFileFailsBootstrapInsteadOfBeingReplaced(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        $path = $storage->publishedPath();
        file_put_contents($path, '{ not json');

        try {
            $storage->initialize();
            self::fail('initialize() accepted a malformed published.json');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::INVALID_JSON, $exception->storageCode);
            self::assertSame('published', $exception->fileRole);
        }

        self::assertSame('{ not json', file_get_contents($path), 'the invalid file was rewritten');
    }

    public function testASchemaIncompatibleFileFailsBootstrap(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        $envelope = json_decode((string) file_get_contents($storage->publishedPath()), true);
        $envelope['content']['hero']['primaryCta']['id'] = 'renamed';
        file_put_contents($storage->publishedPath(), json_encode($envelope));

        $this->expectException(StorageException::class);

        try {
            $storage->initialize();
        } catch (StorageException $exception) {
            self::assertSame(StorageException::VALIDATION_FAILED, $exception->storageCode);

            throw $exception;
        }
    }

    public function testAFileOverTheSizeCapIsRejectedWithoutBeingRead(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        file_put_contents($storage->publishedPath(), str_repeat('x', ContentStorage::MAX_FILE_BYTES + 1));

        try {
            $storage->readPublished();
            self::fail('an oversized file was read');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::FILE_TOO_LARGE, $exception->storageCode);
        }
    }

    public function testAnAbsentFileIsSeededByTheReadPathRatherThanFailing(): void
    {
        // ESZ-013 moved seeding out of bootstrap and into the read that needs it,
        // so a first deployment answers `GET /api/content` instead of 500-ing on
        // storage that has never been written. The observable behaviour is
        // unchanged from Package 1.1, where per-request bootstrap re-seeded an
        // absent file just the same; only the moment moved.
        //
        // Absent is the *only* state that gets this treatment. The neighbouring
        // tests pin the other half: a file that exists but is malformed,
        // schema-incompatible or oversized is refused and left untouched, never
        // "recovered" by overwriting an editor's work with defaults.
        $storage = $this->storage();
        $storage->initialize();
        unlink($storage->publishedPath());

        $envelope = $storage->readPublished();

        self::assertFileExists($storage->publishedPath());
        self::assertSame(0, $envelope['revision']);
        self::assertSame(
            TestEnvironment::artifacts()->canonicalSiteContent()['hero'],
            $envelope['content']['hero'],
        );
    }

    public function testAReadTakesASharedLockSoConcurrentReadsDoNotSerialise(): void
    {
        // Package 1.1 took the exclusive lock on every request, because bootstrap
        // called initialize() and initialize() might seed. Reads therefore queued
        // behind one another for a write that essentially never happens. Proven by
        // holding a shared lock from outside for the whole read: under LOCK_EX the
        // read would block until the timeout below fires.
        $storage = $this->storage();
        $storage->initialize();

        $lockFile = $this->root . '/data/locks/content.lock';
        $handle = fopen($lockFile, 'c');
        self::assertIsResource($handle);
        self::assertTrue(flock($handle, LOCK_SH));

        try {
            $envelope = $storage->readPublished();
            self::assertSame(0, $envelope['revision']);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    public function testWritingAnInvalidEnvelopeLeavesTheStoredOneUntouched(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        $before = (string) file_get_contents($storage->publishedPath());

        $envelope = $storage->readPublished();
        $envelope['revision'] = -3;

        try {
            $storage->writePublished($envelope);
            self::fail('an invalid envelope was written');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::VALIDATION_FAILED, $exception->storageCode);
        }

        self::assertSame($before, file_get_contents($storage->publishedPath()));
    }

    public function testWritesNormaliseBeforePersisting(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        $envelope = $storage->readPublished();
        $envelope['content']['appearance']['palette']['primary'] = '#63726c';
        $storage->writePublished($envelope);

        $stored = json_decode((string) file_get_contents($storage->publishedPath()), true);

        self::assertSame('#63726C', $stored['content']['appearance']['palette']['primary']);
    }

    public function testNoTemporaryFileSurvivesASuccessfulWrite(): void
    {
        $storage = $this->storage();
        $storage->initialize();
        $storage->writePublished($storage->readPublished());

        self::assertSame([], glob($this->root . '/var/tmp/*') ?: []);
        self::assertSame(
            ['draft.json', 'published.json'],
            array_values(array_diff(scandir($this->root . '/data/content') ?: [], ['.', '..'])),
        );
    }

    public function testTheLockFileLivesOutsideTheContentDirectory(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        // A lock file inside data/content/ would be a third file the storage
        // layer has to explain away on every directory listing.
        self::assertFileExists($this->root . '/data/locks/content.lock');
        self::assertFileDoesNotExist($this->root . '/data/content/content.lock');
    }

    public function testACrossFilesystemTempDirectoryIsRefusedAtBootstrap(): void
    {
        $artifacts = TestEnvironment::artifacts();

        $storage = new ContentStorage(
            $this->root . '/data/content',
            '/dev/shm/eszter-cross-device-check',
            $this->root . '/data/locks',
            $artifacts,
            ContentValidator::create($artifacts),
            new FrozenClock(self::NOW),
        );

        if (!is_dir('/dev/shm')) {
            self::markTestSkipped('No second filesystem available to test against.');
        }

        try {
            $storage->initialize();
            self::fail('a cross-filesystem temp directory was accepted');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::CROSS_DEVICE_TMP, $exception->storageCode);
        } finally {
            @rmdir('/dev/shm/eszter-cross-device-check');
        }
    }
}
