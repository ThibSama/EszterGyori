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
}
