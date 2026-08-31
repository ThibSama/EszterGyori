<?php

declare(strict_types=1);

namespace Eszter\Tests\Contract;

use Eszter\Contract\JsonPointer;
use PHPUnit\Framework\TestCase;

/**
 * The corpus runner's only moving part. If pointers or patches are wrong, every
 * parity case silently validates the wrong document.
 */
final class JsonPointerTest extends TestCase
{
    public function testEscapeSequencesRoundTrip(): void
    {
        self::assertSame(['a/b', 'c~d'], JsonPointer::parse('/a~1b/c~0d'));
        self::assertSame('/a~1b/c~0d', JsonPointer::compile(['a/b', 'c~d']));
        self::assertSame([], JsonPointer::parse(''));
        self::assertSame('', JsonPointer::compile([]));
    }

    public function testARelativePointerIsRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        JsonPointer::parse('a/b');
    }

    public function testResolveReturnsNullRatherThanThrowingOnAMissingPath(): void
    {
        self::assertNull(JsonPointer::resolve(['a' => 1], '/b/c'));
        self::assertSame(1, JsonPointer::resolve(['a' => 1], '/a'));
    }

    public function testTheThreePatchOperations(): void
    {
        $document = ['items' => [['id' => 'a'], ['id' => 'b']], 'flag' => true];

        self::assertSame(
            ['items' => [['id' => 'z'], ['id' => 'b']], 'flag' => true],
            JsonPointer::applyPatch($document, [['op' => 'replace', 'path' => '/items/0/id', 'value' => 'z']]),
        );

        self::assertSame(
            ['items' => [['id' => 'a', 'extra' => 1], ['id' => 'b']], 'flag' => true],
            JsonPointer::applyPatch($document, [['op' => 'add', 'path' => '/items/0/extra', 'value' => 1]]),
        );

        self::assertSame(
            ['items' => [['id' => 'a'], ['id' => 'b']]],
            JsonPointer::applyPatch($document, [['op' => 'remove', 'path' => '/flag']]),
        );
    }

    public function testRemovingFromAListReindexesIt(): void
    {
        $patched = JsonPointer::applyPatch(
            ['items' => ['a', 'b', 'c']],
            [['op' => 'remove', 'path' => '/items/1']],
        );

        // Leaving a hole would turn the list into a map on re-encoding, and the
        // document would no longer be the one the corpus describes.
        self::assertSame(['items' => ['a', 'c']], $patched);
    }

    public function testRemovingTheRootIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        JsonPointer::applyPatch(['a' => 1], [['op' => 'remove', 'path' => '']]);
    }

    public function testAnUnresolvableParentIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        JsonPointer::applyPatch(['a' => 1], [['op' => 'replace', 'path' => '/x/y', 'value' => 1]]);
    }
}
