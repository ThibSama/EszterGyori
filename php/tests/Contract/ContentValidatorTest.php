<?php

declare(strict_types=1);

namespace Eszter\Tests\Contract;

use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifacts;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Behaviour the parity corpus does not reach.
 *
 * Every corpus case patches a structurally valid document, so the corpus proves
 * the semantic layer and says nothing about the structural one, about the
 * envelope targets other than `publishedEnvelope`, or about where issues land
 * when both layers could speak. Those are covered here.
 */
final class ContentValidatorTest extends TestCase
{
    private static ?ContractArtifacts $artifacts = null;
    private static ?ContentValidator $validator = null;

    private static function validator(): ContentValidator
    {
        self::$artifacts ??= TestEnvironment::artifacts();

        return self::$validator ??= ContentValidator::create(self::$artifacts);
    }

    /** @return array<string, mixed> */
    private static function content(): array
    {
        self::$artifacts ??= TestEnvironment::artifacts();

        return self::$artifacts->canonicalSiteContent();
    }

    /** @return array<string, mixed> */
    private static function envelope(string $timestampField): array
    {
        return [
            'schemaVersion' => 1,
            'revision' => 7,
            $timestampField => '2026-06-13T12:00:00.000Z',
            'content' => self::content(),
        ];
    }

    public function testEveryEnvelopeTargetAcceptsItsOwnShape(): void
    {
        $targets = [
            ContentValidator::TARGET_PUBLISHED_ENVELOPE => 'publishedAt',
            ContentValidator::TARGET_SERVER_DRAFT_ENVELOPE => 'updatedAt',
        ];

        foreach ($targets as $target => $field) {
            $result = self::validator()->validate(self::envelope($field), $target);
            self::assertTrue($result->valid, "{$target}: " . $result->summary());
        }

        // The browser-side draft envelope carries `savedAt` and no revision.
        $draft = [
            'schemaVersion' => 1,
            'savedAt' => '2026-06-13T12:00:00.000Z',
            'content' => self::content(),
        ];

        $result = self::validator()->validate($draft, ContentValidator::TARGET_SITE_CONTENT_DRAFT);
        self::assertTrue($result->valid, $result->summary());
    }

    public function testAnEnvelopeTargetRejectsAnotherTargetsTimestampField(): void
    {
        $result = self::validator()->validate(
            self::envelope('updatedAt'),
            ContentValidator::TARGET_PUBLISHED_ENVELOPE,
        );

        self::assertFalse($result->valid);
    }

    public function testContentIssuesInsideAnEnvelopeArePrefixed(): void
    {
        $envelope = self::envelope('publishedAt');
        $envelope['content']['hero']['visual']['id'] = 'renamed';

        $result = self::validator()->validate($envelope, ContentValidator::TARGET_PUBLISHED_ENVELOPE);

        self::assertFalse($result->valid);
        self::assertSame(['/content/hero/visual/id'], $result->issuePaths());
    }

    public function testANegativeRevisionIsRejected(): void
    {
        $envelope = self::envelope('publishedAt');
        $envelope['revision'] = -1;

        $result = self::validator()->validate($envelope, ContentValidator::TARGET_PUBLISHED_ENVELOPE);

        self::assertFalse($result->valid);
        self::assertSame(['/revision'], $result->issuePaths());
    }

    public function testRevisionZeroIsAccepted(): void
    {
        $envelope = self::envelope('publishedAt');
        $envelope['revision'] = 0;

        self::assertTrue(
            self::validator()->validate($envelope, ContentValidator::TARGET_PUBLISHED_ENVELOPE)->valid,
        );
    }

    /** @return iterable<string, array{callable(array<string, mixed>): array<string, mixed>, list<string>}> */
    public static function structuralRejections(): iterable
    {
        yield 'unknown key' => [
            static function (array $content): array {
                $content['hero']['surprise'] = 'x';

                return $content;
            },
            ['/hero'],
        ];

        yield 'missing section' => [
            static function (array $content): array {
                unset($content['about']);

                return $content;
            },
            [''],
        ];

        yield 'wrong scalar type' => [
            static function (array $content): array {
                $content['hero']['description'] = 42;

                return $content;
            },
            ['/hero/description'],
        ];

        yield 'value outside the enum' => [
            static function (array $content): array {
                $content['process']['steps'][0]['number'] = '99';

                return $content;
            },
            ['/process/steps/0/number'],
        ];

        yield 'array shorter than the fixed length' => [
            static function (array $content): array {
                array_pop($content['gallery']['items']);

                return $content;
            },
            ['/gallery/items'],
        ];

        yield 'hex colour that is not a hex colour' => [
            static function (array $content): array {
                $content['appearance']['palette']['text'] = 'rebeccapurple';

                return $content;
            },
            ['/appearance/palette/text'],
        ];
    }

    /**
     * @param callable(array<string, mixed>): array<string, mixed> $mutate
     * @param list<string> $expectedPaths
     */
    #[DataProvider('structuralRejections')]
    public function testStructuralRejectionsPointAtTheOffendingNode(
        callable $mutate,
        array $expectedPaths,
    ): void {
        $result = self::validator()->validate($mutate(self::content()), ContentValidator::TARGET_SITE_CONTENT);

        self::assertFalse($result->valid);
        self::assertSame($expectedPaths, $result->issuePaths());
    }

    public function testStructuralFailureSuppressesSemanticIssues(): void
    {
        // Both layers have something to say: the id is outside the enum *and*
        // out of order. Only the structural issue is reported, mirroring the
        // reference where a `.superRefine` never runs over an object that failed
        // to parse.
        $content = self::content();
        $content['services']['items'][0]['id'] = 'not-a-service';

        $result = self::validator()->validate($content, ContentValidator::TARGET_SITE_CONTENT);

        self::assertFalse($result->valid);
        self::assertSame(['/services/items/0/id'], $result->issuePaths());
    }

    public function testNormalisationIsAppliedToTheValueCallersReceive(): void
    {
        $content = self::content();
        unset($content['appearance']);
        $content['hero']['visual']['src'] = '/media/hero.webp';

        $result = self::validator()->validate($content, ContentValidator::TARGET_SITE_CONTENT);

        self::assertTrue($result->valid, $result->summary());
        /** @var array<string, mixed> $value */
        $value = $result->value;
        self::assertSame('#F5F4F1', $value['appearance']['palette']['background']);
        self::assertSame('/media/hero.webp', $value['hero']['visual']['src']);
    }

    public function testNormalisationInsideAnEnvelopeReachesTheContent(): void
    {
        $envelope = self::envelope('publishedAt');
        $envelope['content']['appearance']['palette']['primary'] = '#63726c';

        $result = self::validator()->validate($envelope, ContentValidator::TARGET_PUBLISHED_ENVELOPE);

        self::assertTrue($result->valid, $result->summary());
        /** @var array<string, mixed> $value */
        $value = $result->value;
        self::assertSame('#63726C', $value['content']['appearance']['palette']['primary']);
        self::assertSame(7, $value['revision']);
    }

    public function testUnknownTargetIsARefusal(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        self::validator()->validate(self::content(), 'notATarget');
    }
}
