<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Contract\Appearance;
use Eszter\Http\PublicPageBootstrap;
use Eszter\Http\PublicPageBootstrapException;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The injector, on its own (ESZ-021).
 *
 * `HttpContractConformanceTest` proves the endpoint answers what the contract
 * froze. This proves the thing underneath it: that rewriting a build artifact in
 * place is safe, bounded, and fails in the one direction that is survivable.
 *
 * The two properties worth stating up front, because they are what the design
 * rests on:
 *
 *  - **it edits, it does not render.** Everything outside the two elements must
 *    come out byte-identical, or PHP has quietly become a second renderer;
 *  - **it never half-succeeds.** A page with new content and a stale palette, or
 *    with a payload spliced into the wrong element, is worse than the untouched
 *    export — so a failure raises and the caller serves the file as it found it.
 */
final class PublicPageBootstrapTest extends TestCase
{
    private function bootstrap(): PublicPageBootstrap
    {
        return PublicPageBootstrap::fromArtifacts(TestEnvironment::artifacts());
    }

    /** @return array<string, mixed> */
    private function envelope(int $revision = 12, string $description = 'Bonjour'): array
    {
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        $content['hero']['description'] = $description;

        return [
            'schemaVersion' => 1,
            'revision' => $revision,
            'publishedAt' => '2026-06-13T12:00:00.000Z',
            'content' => $content,
        ];
    }

    private function page(): string
    {
        return '<!DOCTYPE html><html><head>'
            . '<style id="__ESZTER_APPEARANCE__">:root{--site-background:#000000}</style>'
            . '</head><body><p>KEEP-ME</p>'
            . '<script type="application/json" id="__ESZTER_CONTENT__">{"revision":0}</script>'
            . '<script>keep()</script><!--TAIL--></body></html>';
    }

    private function extract(string $tag, string $id, string $html): string
    {
        $pattern = \sprintf('#<%1$s\b[^>]*\bid="%2$s"[^>]*>(.*?)</%1$s>#s', $tag, $id);
        self::assertSame(1, preg_match($pattern, $html, $matches), "no <{$tag} id={$id}>");

        return $matches[1];
    }

    public function testThePublishedEnvelopeReplacesTheBakedOne(): void
    {
        $html = $this->bootstrap()->inject($this->page(), $this->envelope(31));

        $payload = json_decode($this->extract('script', '__ESZTER_CONTENT__', $html), true);

        self::assertIsArray($payload);
        self::assertSame(31, $payload['revision']);
        self::assertSame('Bonjour', $payload['content']['hero']['description']);
    }

    public function testEverythingOutsideTheTwoElementsIsUntouched(): void
    {
        // The whole boundary in one assertion: PHP owns two elements and nothing
        // else. A regex that is one character too greedy shows up here.
        $html = $this->bootstrap()->inject($this->page(), $this->envelope());

        self::assertStringContainsString('<p>KEEP-ME</p>', $html);
        self::assertStringContainsString('<script>keep()</script>', $html);
        self::assertStringContainsString('<!--TAIL-->', $html);
        self::assertStringContainsString('<!DOCTYPE html>', $html);
        self::assertStringEndsWith('</body></html>', $html);
    }

    public function testTheElementIsFoundByIdRegardlessOfItsOtherAttributes(): void
    {
        // The bundler may reorder or add attributes between builds. Matching a
        // remembered opening tag would make injection stop silently — the site
        // would keep serving the last build and look perfectly healthy.
        $page = str_replace(
            '<script type="application/json" id="__ESZTER_CONTENT__">',
            '<script data-a="1" id="__ESZTER_CONTENT__" type="application/json" data-b="2">',
            $this->page(),
        );

        $html = $this->bootstrap()->inject($page, $this->envelope(9));
        $payload = json_decode($this->extract('script', '__ESZTER_CONTENT__', $html), true);

        self::assertIsArray($payload);
        self::assertSame(9, $payload['revision']);
        self::assertStringContainsString('data-b="2"', $html, 'the opening tag was rewritten');
    }

    public function testAMissingElementRaisesRatherThanProducingAHalfInjectedPage(): void
    {
        foreach (['__ESZTER_CONTENT__', '__ESZTER_APPEARANCE__'] as $missing) {
            $page = str_replace($missing, 'SOMETHING-ELSE', $this->page());

            try {
                $this->bootstrap()->inject($page, $this->envelope());
                self::fail("a page without {$missing} was injected into anyway");
            } catch (PublicPageBootstrapException $exception) {
                self::assertStringContainsString($missing, $exception->getMessage());
            }
        }
    }

    public function testEditorialCopyCannotTerminateTheScriptElement(): void
    {
        // The attack the encoding exists for: a description that closes the
        // element and continues as markup.
        $hostile = '</script><img src=x onerror=alert(1)> & <!-- \'"';

        $html = $this->bootstrap()->inject($this->page(), $this->envelope(4, $hostile));
        $payload = $this->extract('script', '__ESZTER_CONTENT__', $html);

        foreach (['<', '>', '&'] as $character) {
            self::assertStringNotContainsString($character, $payload);
        }
        self::assertDoesNotMatchRegularExpression('#</script#i', $payload);

        // The word "onerror" survives as *text* inside the payload, and should:
        // escaping is not censorship, and an editor may legitimately write it. What
        // must not survive is the markup — no new element enters the document.
        self::assertStringNotContainsString('<img', $html);
        self::assertSame(
            substr_count($this->page(), '<script'),
            substr_count($html, '<script'),
            'injection introduced a new element',
        );

        // Lossless: the editor gets back exactly what they typed.
        $decoded = json_decode($payload, true);
        self::assertIsArray($decoded);
        self::assertSame($hostile, $decoded['content']['hero']['description']);
    }

    public function testTheInjectedPayloadIsStillValidJson(): void
    {
        // JSON_HEX_QUOT escapes quotes inside string values while json_encode
        // emits the delimiters itself. A substitution over finished JSON would
        // have rewritten the delimiters too and produced something unparseable.
        $payload = $this->extract(
            'script',
            '__ESZTER_CONTENT__',
            $this->bootstrap()->inject($this->page(), $this->envelope()),
        );

        self::assertIsArray(json_decode($payload, true));
        self::assertSame(JSON_ERROR_NONE, json_last_error());
    }

    public function testFrenchCopyIsInjectedAsUtf8RatherThanEscaped(): void
    {
        $html = $this->bootstrap()->inject($this->page(), $this->envelope(1, 'Sourcils à Lille'));

        // Matches what GET /api/content sends and what the export baked in, so the
        // page and the API do not disagree about encoding.
        self::assertStringContainsString('Sourcils à Lille', $html);
    }

    public function testTheAppearanceBlockIsColoursOnly(): void
    {
        $html = $this->bootstrap()->inject($this->page(), $this->envelope());
        $block = $this->extract('style', '__ESZTER_APPEARANCE__', $html);

        self::assertMatchesRegularExpression(
            '#^:root\{(--site-[a-z-]+:\#[0-9A-F]{6};)*--site-[a-z-]+:\#[0-9A-F]{6}\}$#',
            $block,
        );
        self::assertStringNotContainsString('</style', $block);
    }

    public function testTheDeclaredCustomPropertiesAreAllEmittedInOrder(): void
    {
        /** @var array<mixed> $contract */
        $contract = TestEnvironment::artifacts()->httpContract();
        /** @var list<array{name: string}> $declared */
        $declared = $contract['publicPage']['bootstrap']['appearanceCustomProperties'];

        $block = $this->extract(
            'style',
            '__ESZTER_APPEARANCE__',
            $this->bootstrap()->inject($this->page(), $this->envelope()),
        );

        $emitted = [];
        foreach (explode(';', trim($block, ':root{}')) as $declaration) {
            $emitted[] = explode(':', $declaration)[0];
        }

        // Equality, not containment: PHP emits exactly the list the frontend
        // generated, so neither side can quietly add or drop a property.
        self::assertSame(array_column($declared, 'name'), $emitted);
    }

    public function testAValueThatIsNotAHexColourIsDroppedRatherThanEmitted(): void
    {
        // Unreachable through the validator, which is the point: this is the last
        // gate before an editorial value becomes CSS text, and it must hold even
        // if something upstream stops holding.
        $envelope = $this->envelope();
        $envelope['content']['appearance']['palette']['primary'] = 'red;} body{display:none';

        $block = $this->bootstrap()->renderAppearance($envelope['content']['appearance']);

        self::assertStringNotContainsString('display:none', $block);
        self::assertStringNotContainsString('--site-primary:', $block);
        self::assertMatchesRegularExpression(
            '#^:root\{(--site-[a-z-]+:\#[0-9A-F]{6};)*--site-[a-z-]+:\#[0-9A-F]{6}\}$#',
            $block,
        );
    }

    public function testReadableForegroundMatchesTheContractRule(): void
    {
        // `--site-primary-contrast` is the one derived property. The rule is the
        // contract's own, so the expectations are stated as contrast outcomes
        // rather than as remembered hex values.
        self::assertSame(Appearance::DARK_FOREGROUND, Appearance::readableForeground('#FFFFFF'));
        self::assertSame(Appearance::LIGHT_FOREGROUND, Appearance::readableForeground('#000000'));

        foreach (['#63726C', '#A8AEB8', '#D3D1CD', '#2C2B28'] as $background) {
            $chosen = Appearance::readableForeground($background);
            $other = $chosen === Appearance::LIGHT_FOREGROUND
                ? Appearance::DARK_FOREGROUND
                : Appearance::LIGHT_FOREGROUND;

            self::assertGreaterThanOrEqual(
                Appearance::contrastRatio($background, $other),
                Appearance::contrastRatio($background, $chosen),
                "a less legible foreground was chosen for {$background}",
            );
        }
    }
}
