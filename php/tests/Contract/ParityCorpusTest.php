<?php

declare(strict_types=1);

namespace Eszter\Tests\Contract;

use Eszter\Contract\ContentValidator;
use Eszter\Contract\JsonPointer;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-011's proof obligation.
 *
 * `contracts/generated/parity-corpus.json` is replayed here exactly as
 * `contracts/tests/parity-corpus.test.ts` replays it in TypeScript: apply the
 * case's patch to the declared base, validate, and compare **both** the
 * accept/reject outcome **and** the issue paths.
 *
 * `docs/v1-quality-gates.md`: "`php:parity-corpus` is the gate that makes the
 * migration safe. Until it runs green, no claim that PHP implements the contract
 * is supported by evidence."
 */
final class ParityCorpusTest extends TestCase
{
    private static ?ContentValidator $validator = null;

    /** @var array<mixed>|null */
    private static ?array $corpus = null;

    /** @return array<mixed> */
    private static function corpus(): array
    {
        return self::$corpus ??= TestEnvironment::artifacts()->parityCorpus();
    }

    private static function validator(): ContentValidator
    {
        return self::$validator ??= ContentValidator::create(TestEnvironment::artifacts());
    }

    /** @return iterable<string, array{array<mixed>}> */
    public static function corpusCases(): iterable
    {
        /** @var list<array<mixed>> $cases */
        $cases = self::corpus()['cases'];

        foreach ($cases as $case) {
            /** @var string $id */
            $id = $case['id'];
            yield $id => [$case];
        }
    }

    public function testCorpusDeclaresOnlyTheSupportedPatchSubset(): void
    {
        self::assertSame('RFC 6901', self::corpus()['pointerSpec']);
        self::assertSame(['replace', 'add', 'remove'], self::corpus()['patchOperations']);
    }

    public function testBothCorpusBaseDocumentsValidateAsIs(): void
    {
        foreach (['siteContent', 'publishedEnvelope'] as $target) {
            $result = self::validator()->validate($this->baseFor($target), $this->targetFor($target));

            self::assertTrue(
                $result->valid,
                "corpus base `{$target}` was rejected: " . $result->summary(),
            );
        }
    }

    /** @param array<mixed> $case */
    #[DataProvider('corpusCases')]
    public function testParityCase(array $case): void
    {
        /** @var string $id */
        $id = $case['id'];
        /** @var string $target */
        $target = $case['target'];
        /** @var list<array{op: string, path: string, value?: mixed}> $patch */
        $patch = $case['patch'];

        $document = JsonPointer::applyPatch($this->baseFor($target), $patch);

        self::assertNotSame(
            json_encode($document),
            json_encode($this->baseFor($target)),
            "{$id}: patch is a no-op, so the case proves nothing",
        );

        $result = self::validator()->validate($document, $this->targetFor($target));
        $expectValid = $case['expect'] === 'valid';

        self::assertSame(
            $expectValid,
            $result->valid,
            "{$id}: expected {$case['expect']}, got "
                . ($result->valid ? 'valid' : 'invalid (' . $result->summary() . ')'),
        );

        if (!$expectValid) {
            /** @var list<string> $expected */
            $expected = $case['expectedIssuePaths'] ?? [];

            self::assertNotEmpty($expected, "{$id} must declare expectedIssuePaths");

            $actual = $result->issuePaths();
            sort($expected);
            sort($actual);

            self::assertSame($expected, $actual, "{$id}: issue paths diverged");

            return;
        }

        /** @var array<string, mixed> $normalization */
        $normalization = $case['expectedNormalization'] ?? [];

        foreach ($normalization as $pointer => $expectedValue) {
            self::assertSame(
                $expectedValue,
                JsonPointer::resolve($result->value, $pointer),
                "{$id}: {$pointer} was not normalized as declared",
            );
        }
    }

    /** @return array<string, mixed> */
    private function baseFor(string $target): array
    {
        /** @var array<string, mixed> $base */
        $base = self::corpus()['bases'][$target];

        return $base;
    }

    private function targetFor(string $target): string
    {
        return $target === 'siteContent'
            ? ContentValidator::TARGET_SITE_CONTENT
            : ContentValidator::TARGET_PUBLISHED_ENVELOPE;
    }
}
