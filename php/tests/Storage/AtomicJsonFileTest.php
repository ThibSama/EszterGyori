<?php

declare(strict_types=1);

namespace Eszter\Tests\Storage;

use Eszter\Storage\AtomicJsonFile;
use Eszter\Storage\StorageException;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

final class AtomicJsonFileTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-atomic');
        mkdir($this->root . '/tmp', 0o700, true);
        mkdir($this->root . '/content', 0o700, true);
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    private function writer(string $tmp = '/tmp'): AtomicJsonFile
    {
        return new AtomicJsonFile($this->root . $tmp);
    }

    public function testEncodingMatchesTheReferenceImplementationByteForByte(): void
    {
        $target = $this->root . '/content/x.json';
        $this->writer()->write($target, ['a' => 1, 'b' => ['c' => 'é/f']]);

        // Two-space indent, unescaped slashes, UTF-8 rather than \uXXXX, trailing
        // newline: `JSON.stringify(payload, null, 2) + "\n"`. Matching this makes
        // a file written by either backend diffable against the other's.
        self::assertSame(
            "{\n  \"a\": 1,\n  \"b\": {\n    \"c\": \"é/f\"\n  }\n}\n",
            file_get_contents($target),
        );
    }

    public function testTheTemporaryFileIsStagedInTheConfiguredTmpDirectory(): void
    {
        $target = $this->root . '/content/x.json';

        // Staging beside the target would make the temp file briefly visible to a
        // reader listing the content directory.
        $this->writer()->write($target, ['a' => 1]);

        self::assertSame([], glob($this->root . '/tmp/*') ?: []);
        self::assertSame(['x.json'], array_map('basename', glob($this->root . '/content/*') ?: []));
    }

    public function testThePublishedFileIsNotWorldReadable(): void
    {
        $target = $this->root . '/content/x.json';
        $this->writer()->write($target, ['a' => 1]);

        self::assertSame(AtomicJsonFile::FILE_MODE, fileperms($target) & 0o777);
    }

    public function testReplacingKeepsThePreviousContentWhenTheWriteCannotStart(): void
    {
        $target = $this->root . '/content/x.json';
        $this->writer()->write($target, ['a' => 1]);
        $before = (string) file_get_contents($target);

        $writer = $this->writer('/tmp');
        chmod($this->root . '/tmp', 0o500);

        try {
            $writer->write($target, ['a' => 2]);
            self::markTestSkipped('The filesystem allowed a write into a read-only directory.');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::WRITE_FAILED, $exception->storageCode);
            self::assertSame($before, file_get_contents($target));
        } finally {
            chmod($this->root . '/tmp', 0o700);
        }
    }

    public function testUnencodablePayloadsAreRefusedBeforeAnyFileIsTouched(): void
    {
        $target = $this->root . '/content/x.json';

        try {
            $this->writer()->write($target, ["\xB1\x31"]);
            self::fail('malformed UTF-8 was encoded');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::WRITE_FAILED, $exception->storageCode);
        }

        self::assertFileDoesNotExist($target);
        self::assertSame([], glob($this->root . '/tmp/*') ?: []);
    }

    public function testMissingDirectoriesAreCreated(): void
    {
        $target = $this->root . '/deep/nested/x.json';
        (new AtomicJsonFile($this->root . '/deep/tmp'))->write($target, ['a' => 1]);

        self::assertFileExists($target);
    }

    // ── ESZ-103: permission boundary ───────────────────────────────────────

    public function testThePublishedFileKeepsPolicyModeUnderAHostileUmaskAndRestoresIt(): void
    {
        $target = $this->root . '/content/x.json';
        $previous = umask(0o000);

        try {
            $this->writer()->write($target, ['a' => 1]);
        } finally {
            umask($previous);
        }

        // The temp is born 0600 under the class's own umask restriction, then
        // restricted to FILE_MODE before the rename — so even with the widest
        // possible process umask the final file carries the policy mode and the
        // process-global umask is back where it was.
        self::assertSame(AtomicJsonFile::FILE_MODE, fileperms($target) & 0o777);
        self::assertSame($previous, umask(), 'the process umask was not restored');
        self::assertSame([], glob($this->root . '/tmp/*') ?: []);
    }

    public function testAFailedModeRestrictionLeavesThePreviousTargetUntouchedAndNoResidue(): void
    {
        $target = $this->root . '/content/x.json';
        $this->writer()->write($target, ['a' => 1]);
        $before = (string) file_get_contents($target);

        // The seam refuses the chmod; the write must fail closed instead of
        // publishing a file whose restriction could not be established.
        $failing = new AtomicJsonFile(
            $this->root . '/tmp',
            static fn (string $path, int $mode): bool => false,
        );

        try {
            $failing->write($target, ['a' => 2]);
            self::fail('a refused mode restriction published the document');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::WRITE_FAILED, $exception->storageCode);
        }

        self::assertSame($before, file_get_contents($target));
        self::assertSame([], glob($this->root . '/tmp/*') ?: [], 'a temp file survived the refusal');
    }

    public function testAModeThatWasAcceptedButDidNotTakeEffectIsRefusedByTheVerification(): void
    {
        $target = $this->root . '/content/x.json';

        // Simulates a filesystem or wrapper that accepts chmod() and leaves the
        // file wider. The seam reports success; the hard fileperms verification
        // is what must refuse — a chmod call alone is not proof.
        $lying = new AtomicJsonFile(
            $this->root . '/tmp',
            static fn (string $path, int $mode): bool => true,
        );

        try {
            $lying->write($target, ['a' => 1]);
            self::fail('an unverified mode restriction published the document');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::WRITE_FAILED, $exception->storageCode);
        }

        self::assertFileDoesNotExist($target);
        self::assertSame([], glob($this->root . '/tmp/*') ?: [], 'a temp file survived the refusal');
    }

    public function testTheProcessUmaskIsRestoredWhenAWriteFails(): void
    {
        $target = $this->root . '/content/x.json';
        $original = umask(0o077);
        chmod($this->root . '/tmp', 0o500);

        try {
            try {
                $this->writer()->write($target, ['a' => 1]);
                self::markTestSkipped('The filesystem allowed a write into a read-only directory.');
            } catch (StorageException $exception) {
                self::assertSame(StorageException::WRITE_FAILED, $exception->storageCode);
                self::assertFileDoesNotExist($target);
            } finally {
                self::assertSame(0o077, umask(), 'the umask was not restored after the failure');
            }
        } finally {
            chmod($this->root . '/tmp', 0o700);
            umask($original);
        }
    }

    public function testAWriteOntoAPreExistingOverPermissiveTargetCorrectsItsMode(): void
    {
        // A rename replaces the target's inode, so a successful write also
        // replaces an over-permissive pre-existing file with one at FILE_MODE.
        $target = $this->root . '/content/x.json';
        file_put_contents($target, "{}\n");
        chmod($target, 0o666);

        $this->writer()->write($target, ['a' => 1]);

        self::assertSame(AtomicJsonFile::FILE_MODE, fileperms($target) & 0o777);
        self::assertSame("{\n  \"a\": 1\n}\n", file_get_contents($target));
    }
}
