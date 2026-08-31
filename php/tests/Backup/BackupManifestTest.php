<?php

declare(strict_types=1);

namespace Eszter\Tests\Backup;

use Eszter\Backup\BackupException;
use Eszter\Backup\BackupManifest;
use Eszter\Backup\BackupSet;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-083 — the integrity record, offline.
 *
 * A backup nobody can verify is a backup nobody should trust, and the verification
 * has to happen *before* the restore writes anything: one that discovered
 * corruption in the last file would already have replaced the database with the
 * first. Everything here is about making that check total — every declared entry
 * present and unaltered, and nothing present that was not declared.
 */
final class BackupManifestTest extends TestCase
{
    /** @var array<string, string> */
    private const ENTRIES = [
        'database/dump.sql' => "INSERT INTO `bookings` VALUES (1);\n",
        'content/published.json' => '{"revision":3}',
        'media/med_0123456789abcdef0123456789abcdef.jpg' => 'not really a jpeg',
    ];

    public function testAManifestRoundTripsThroughJson(): void
    {
        $manifest = $this->describe();
        $parsed = BackupManifest::fromJson($manifest->toJson());

        self::assertSame($manifest->entries, $parsed->entries);
        self::assertSame($manifest->entriesDigest, $parsed->entriesDigest);
        self::assertSame($manifest->appliedMigrations, $parsed->appliedMigrations);
        self::assertSame($manifest->rowCounts, $parsed->rowCounts);
        self::assertSame($manifest->createdAt, $parsed->createdAt);
    }

    public function testAMatchingArchivePasses(): void
    {
        $this->describe()->assertMatches(
            [BackupSet::MANIFEST_FILE => 'ignored'] + self::ENTRIES,
        );

        $this->expectNotToPerformAssertions();
    }

    public function testAMissingEntryIsRefused(): void
    {
        $archive = self::ENTRIES;
        unset($archive['content/published.json']);

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/missing a file it declares/');

        $this->describe()->assertMatches($archive);
    }

    /** One byte, same length, so only the digest can catch it. */
    public function testAnAlteredEntryIsRefused(): void
    {
        $archive = self::ENTRIES;
        $archive['content/published.json'] = '{"revision":4}';

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/does not match its recorded digest/');

        $this->describe()->assertMatches($archive);
    }

    public function testAnEntryOfADifferentLengthIsRefused(): void
    {
        $archive = self::ENTRIES;
        $archive['content/published.json'] = '{"revision":3} ';

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/bytes; the manifest declares/');

        $this->describe()->assertMatches($archive);
    }

    /**
     * The direction that is easy to forget.
     *
     * A file the manifest does not declare means the archive was assembled by
     * something other than this tool, and a restore that wrote it would be writing
     * a file nobody declared — which is how an archive stops being a backup and
     * starts being a delivery mechanism.
     */
    public function testAnUndeclaredExtraEntryIsRefused(): void
    {
        $archive = self::ENTRIES + ['content/../config.php' => '<?php'];

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/does not declare/');

        $this->describe()->assertMatches($archive);
    }

    /**
     * Rewriting a digest inside the manifest must not be enough.
     *
     * Without `entriesDigest`, altering a file and its recorded digest together
     * would produce an archive that verified perfectly. The digest over the entry
     * list is what makes the manifest defend itself.
     */
    public function testAManifestWhoseEntriesWereRewrittenIsRefused(): void
    {
        /** @var array<string, mixed> $decoded */
        $decoded = json_decode($this->describe()->toJson(), true);
        /** @var array<string, array{bytes: int, sha256: string}> $entries */
        $entries = $decoded['entries'];
        $entries['content/published.json']['sha256'] = hash('sha256', '{"revision":4}');
        $decoded['entries'] = $entries;

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/has been altered/');

        BackupManifest::fromJson((string) json_encode($decoded));
    }

    /** A format this code does not know may mean something else entirely. */
    public function testAnUnknownFormatVersionIsRefused(): void
    {
        /** @var array<string, mixed> $decoded */
        $decoded = json_decode($this->describe()->toJson(), true);
        $decoded['formatVersion'] = BackupSet::FORMAT_VERSION + 1;

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/format version/');

        BackupManifest::fromJson((string) json_encode($decoded));
    }

    public function testGarbageIsRefusedRatherThanPartiallyBelieved(): void
    {
        $this->expectException(BackupException::class);

        BackupManifest::fromJson('not json at all');
    }

    /** The manifest tells an operator what was left out, not only what was taken. */
    public function testTheExclusionsAreRecordedByName(): void
    {
        self::assertSame(
            array_keys(BackupSet::EXCLUDED_TABLES),
            array_keys(BackupManifest::fromJson($this->describe()->toJson())->excludedTables),
        );
    }

    private function describe(): BackupManifest
    {
        return BackupManifest::describe(
            self::ENTRIES,
            '2026-06-13T12:00:00.000Z',
            ['0001', '0002'],
            ['bookings' => 1],
            1,
            2,
            BackupSet::EXCLUDED_TABLES,
        );
    }
}
