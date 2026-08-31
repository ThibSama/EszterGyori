<?php

declare(strict_types=1);

namespace Eszter\Tests\Contract;

use Eszter\Contract\ContentValidator;
use Eszter\Contract\SemanticRuleValidator;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * Drift prevention in the direction the parity corpus cannot cover.
 *
 * The corpus proves the rules that exist behave identically. It cannot prove a
 * *new* rule was ported: adding one upstream regenerates `semantic-rules.json`
 * and adds corpus cases, but a PHP backend that ignores the new id would simply
 * accept the new cases. These tests close that gap.
 */
final class SemanticRuleCoverageTest extends TestCase
{
    public function testEveryDeclaredRuleIsImplemented(): void
    {
        $declared = array_keys(TestEnvironment::artifacts()->semanticRules());
        $missing = array_diff($declared, SemanticRuleValidator::RULES);

        self::assertSame(
            [],
            array_values($missing),
            'semantic-rules.json declares rules SemanticRuleValidator does not implement.',
        );
    }

    public function testNoImplementedRuleHasBeenRetiredUpstream(): void
    {
        $declared = array_keys(TestEnvironment::artifacts()->semanticRules());
        $orphaned = array_diff(SemanticRuleValidator::RULES, $declared);

        self::assertSame(
            [],
            array_values($orphaned),
            'SemanticRuleValidator implements rules semantic-rules.json no longer declares.',
        );
    }

    public function testBootstrapRefusesAnUnimplementedRule(): void
    {
        $validator = new SemanticRuleValidator();

        $this->expectExceptionMessageMatches('/does not implement: some\.newRule/');

        $validator->assertCoversDeclaredRules(
            array_fill_keys([...SemanticRuleValidator::RULES, 'some.newRule'], []),
        );
    }

    public function testTheGalleryInstagramCtaIdRuleIsDeclaredUpstreamAndEnforcedHere(): void
    {
        // Package 1.1 enforced `galleryContentSchema.instagramCta.superRefine`
        // under a local id because `semantic-rules.json` declared no entry for it.
        // Package 1.2 canonicalised the rule upstream, so it is now an ordinary
        // declared rule; this test pins the specific behaviour the workaround used
        // to protect, so removing the workaround cannot also lose the coverage.
        self::assertContains('gallery.instagramCtaFixedId', SemanticRuleValidator::RULES);

        $artifacts = TestEnvironment::artifacts();
        self::assertArrayHasKey('gallery.instagramCtaFixedId', $artifacts->semanticRules());

        $content = $artifacts->canonicalSiteContent();
        $content['gallery']['instagramCta']['id'] = 'renamed';

        $result = ContentValidator::create($artifacts)
            ->validate($content, ContentValidator::TARGET_SITE_CONTENT);

        self::assertFalse($result->valid);
        self::assertSame(['/gallery/instagramCta/id'], $result->issuePaths());
    }

    public function testEveryDeclaredRuleNamesParityCasesThatExist(): void
    {
        $artifacts = TestEnvironment::artifacts();
        /** @var list<array<mixed>> $cases */
        $cases = $artifacts->parityCorpus()['cases'];
        $caseIds = array_column($cases, 'id');

        foreach ($artifacts->semanticRules() as $id => $rule) {
            /** @var list<string> $parityCaseIds */
            $parityCaseIds = $rule['parityCaseIds'] ?? [];

            self::assertNotEmpty($parityCaseIds, "rule {$id} names no parity case");

            foreach ($parityCaseIds as $caseId) {
                self::assertContains($caseId, $caseIds, "rule {$id} names unknown case {$caseId}");
            }
        }
    }

    public function testPublicAssetPathPatternMatchesTheGeneratedSchema(): void
    {
        $schema = TestEnvironment::artifacts()->schema('site-content.input.schema.json');
        /** @var string $pattern */
        $pattern = $schema['properties']['hero']['properties']['visual']
            ['properties']['src']['anyOf'][0]['pattern'];

        // The semantic media-source rule re-implements the union, so it carries a
        // copy of the path branch. Asserted equal to the generated pattern here so
        // the copy cannot drift. `\/` is normalised away on both sides: the
        // generated regex escapes forward slashes for a JavaScript literal, which
        // is meaningless to PCRE with a `#` delimiter.
        $unescape = static fn (string $regex): string => str_replace('\\/', '/', $regex);

        self::assertSame(
            $unescape($pattern),
            $unescape(trim(SemanticRuleValidator::PUBLIC_ASSET_PATH_PATTERN, '#')),
        );
    }
}
