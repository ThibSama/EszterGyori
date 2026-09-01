<?php

declare(strict_types=1);

namespace Eszter\Tests\Backup;

use Eszter\Backup\BackupException;
use Eszter\Backup\TarArchive;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-083 — the archive format, offline.
 *
 * This is a format nobody else in the project reads, written by hand because
 * neither `ext-phar` nor a `tar` binary can be assumed on the target host. That is
 * a reasonable trade, and it is only reasonable while the format is proved rather
 * than believed: a backup that cannot be read back is not a backup, and the moment
 * anyone finds out is the moment they need it.
 *
 * The path rules get the most attention here. A restore joins archive names onto a
 * directory, so a name that escapes is a write outside the tree the operator
 * named — which is the difference between a restore tool and a delivery mechanism.
 */
final class TarArchiveTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-tar');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testEntriesRoundTripByteForByte(): void
    {
        $entries = [
            'content/published.json' => '{"revision":7,"content":{"hero":{"title":"Étoile — 100 %"}}}',
            // Deliberately not a multiple of 512: padding is where a hand-written
            // tar writer misaligns the next header, and the symptom shows up
            // several files later than the mistake.
            'media/med_0123456789abcdef0123456789abcdef.jpg' => random_bytes(1_337),
            'database/dump.sql' => str_repeat("INSERT INTO `bookings` VALUES (1);\n", 40),
            // Exactly one block, and empty: the two boundary cases.
            'exactly-one-block.bin' => str_repeat('B', 512),
            'empty.txt' => '',
        ];

        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, $entries, 1_700_000_000);

        self::assertSame($entries, TarArchive::read($path));
    }

    /** Compressed, not merely renamed: the archive travels over FTP and mailboxes. */
    public function testTheArchiveIsGzipped(): void
    {
        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, ['a.txt' => str_repeat('compressible', 5_000)], 1_700_000_000);

        $raw = (string) file_get_contents($path);

        self::assertSame("\x1f\x8b", substr($raw, 0, 2), 'the archive is not gzip-framed');
        self::assertLessThan(5_000, \strlen($raw), 'the archive was not actually compressed');
    }

    /**
     * Two writes of the same entries must be byte-identical, which is what lets
     * "has anything changed since the last backup?" be a digest comparison rather
     * than a diff.
     */
    public function testWritingIsDeterministic(): void
    {
        $entries = ['content/draft.json' => '{"revision":1}', 'media/a.jpg' => 'bytes'];

        TarArchive::write($this->root . '/one.tar.gz', $entries, 1_700_000_000);
        TarArchive::write($this->root . '/two.tar.gz', $entries, 1_700_000_000);

        self::assertSame(
            hash_file('sha256', $this->root . '/one.tar.gz'),
            hash_file('sha256', $this->root . '/two.tar.gz'),
        );
    }

    /**
     * The rule that decides whether an archive can escape its destination.
     *
     * Enforced on the write side as well as the read side, because an archive this
     * application produced should be safe by construction and one it merely
     * received should never be trusted to be.
     */
    #[DataProvider('escapingPaths')]
    public function testAnEscapingPathIsRefusedOnWrite(string $path): void
    {
        $this->expectException(BackupException::class);

        TarArchive::write($this->root . '/archive.tar.gz', [$path => 'x'], 1_700_000_000);
    }

    /** @return iterable<string, array{0: string}> */
    public static function escapingPaths(): iterable
    {
        yield 'parent traversal' => ['../config/config.php'];
        yield 'nested traversal' => ['content/../../config/config.php'];
        yield 'absolute' => ['/etc/passwd'];
        yield 'single dot' => ['./draft.json'];
        yield 'empty segment' => ['content//draft.json'];
        yield 'empty' => [''];
        yield 'null byte' => ["content/draft.json\0.png"];
    }

    /** A truncated archive must be reported as truncated, not read as short. */
    public function testATruncatedArchiveIsRefused(): void
    {
        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, ['media/a.jpg' => str_repeat('x', 4_096)], 1_700_000_000);

        // Decompress, cut the file's data short, recompress: a plausible archive
        // whose last entry does not have the bytes its header promises.
        $raw = (string) gzdecode((string) file_get_contents($path));
        file_put_contents($path, (string) gzencode(substr($raw, 0, 512 + 1_024)));

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/truncated/');

        TarArchive::read($path);
    }

    /**
     * A corrupted header must not be believed.
     *
     * Without the checksum, a damaged size field is read as a size and the reader
     * walks into the middle of the next file's data — producing entries that look
     * like files and are not.
     */
    public function testAHeaderWithABrokenChecksumIsRefused(): void
    {
        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, ['content/draft.json' => '{"revision":1}'], 1_700_000_000);

        $raw = (string) gzdecode((string) file_get_contents($path));
        // Flip a byte in the size field, which the checksum covers.
        $raw[126] = $raw[126] === '7' ? '6' : '7';
        file_put_contents($path, (string) gzencode($raw));

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/checksum/');

        TarArchive::read($path);
    }

    public function testAMalformedSizeHeaderIsRefusedBeforeReadingTheBody(): void
    {
        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, ['content/draft.json' => 'x'], 1_700_000_000);

        $raw = (string) gzdecode((string) file_get_contents($path));
        $raw = substr_replace($raw, "00000000008\0", 124, 12);
        $raw = $this->repairFirstHeaderChecksum($raw);
        file_put_contents($path, (string) gzencode($raw));

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/malformed or overflowing size/');

        TarArchive::read($path);
    }

    public function testAnOversizedEntryIsRefusedFromItsHeader(): void
    {
        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, ['content/draft.json' => 'x'], 1_700_000_000);

        $raw = (string) gzdecode((string) file_get_contents($path));
        $raw = substr_replace($raw, \sprintf('%011o', 1_025) . "\0", 124, 12);
        $raw = $this->repairFirstHeaderChecksum($raw);
        file_put_contents($path, (string) gzencode($raw));

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/per-entry ceiling/');

        TarArchive::read($path, maxEntryBytes: 1_024, maxTotalBytes: 2_048);
    }

    public function testCumulativeExpansionIsBoundedBeforeTheNextBodyIsAllocated(): void
    {
        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, [
            'one.bin' => str_repeat('A', 700),
            'two.bin' => str_repeat('B', 700),
        ], 1_700_000_000);

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/cumulative ceiling/');

        TarArchive::read($path, maxEntryBytes: 800, maxTotalBytes: 1_000);
    }

    public function testEntryCountBoundsEmptyFileCompressionBombs(): void
    {
        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, ['one' => '', 'two' => '', 'three' => ''], 1_700_000_000);

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/entry ceiling/');

        TarArchive::read($path, maxEntries: 2);
    }

    /**
     * An entry that is not a regular file or a directory is refused rather than
     * skipped: a symlink in an archive is a way to describe something other than a
     * file, and skipping one silently would mean a restore that quietly omitted
     * data — or that a slightly different reader would have applied.
     */
    public function testAnUnsupportedEntryTypeIsRefused(): void
    {
        $path = $this->root . '/archive.tar.gz';
        TarArchive::write($path, ['content/draft.json' => 'x'], 1_700_000_000);

        $raw = (string) gzdecode((string) file_get_contents($path));

        // Rewrite the type flag to a symlink and repair the checksum, so the
        // refusal under test is the type check rather than the checksum.
        $raw[156] = '2';
        $blanked = substr_replace($raw, str_repeat(' ', 8), 148, 8);
        $sum = 0;
        for ($i = 0; $i < 512; ++$i) {
            $sum += \ord($blanked[$i]);
        }
        $raw = substr_replace($raw, \sprintf('%06o', $sum) . "\0 ", 148, 8);
        file_put_contents($path, (string) gzencode($raw));

        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/unsupported entry type/');

        TarArchive::read($path);
    }

    /** GNU tar must be able to read what this writes; the operator may well use it. */
    public function testGnuTarCanListWhatThisWriterProduces(): void
    {
        if (trim((string) @shell_exec('command -v tar')) === '') {
            self::markTestSkipped('No tar binary is available to cross-check against.');
        }

        $path = $this->root . '/archive.tar.gz';
        TarArchive::write(
            $path,
            ['content/draft.json' => '{"revision":1}', 'media/a.jpg' => str_repeat('x', 700)],
            1_700_000_000,
        );

        $listing = (string) @shell_exec('tar -tzf ' . escapeshellarg($path) . ' 2>&1');

        self::assertStringContainsString('content/draft.json', $listing);
        self::assertStringContainsString('media/a.jpg', $listing);
        self::assertStringNotContainsString('Unexpected EOF', $listing);
        self::assertStringNotContainsString('checksum error', $listing);
    }

    private function repairFirstHeaderChecksum(string $raw): string
    {
        $header = substr($raw, 0, 512);
        $blanked = substr_replace($header, str_repeat(' ', 8), 148, 8);
        $sum = 0;
        for ($i = 0; $i < 512; ++$i) {
            $sum += \ord($blanked[$i]);
        }

        return substr_replace($raw, \sprintf('%06o', $sum) . "\0 ", 148, 8);
    }
}
