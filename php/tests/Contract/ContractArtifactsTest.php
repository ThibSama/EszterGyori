<?php

declare(strict_types=1);

namespace Eszter\Tests\Contract;

use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\ContentValidator;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The artifacts are this backend's entire notion of the content schema, so a
 * corrupt or partial copy must be loud. These tests exist because the failure
 * mode of a silent one is a validator that accepts more than the contract does.
 */
final class ContractArtifactsTest extends TestCase
{
    public function testEveryDeclaredArtifactLoadsAndMatchesItsDigest(): void
    {
        $verified = TestEnvironment::artifacts()->verifyAll();

        self::assertContains('parity-corpus.json', $verified);
        self::assertContains('semantic-rules.json', $verified);
        self::assertContains('http-contract.json', $verified);
        self::assertGreaterThanOrEqual(11, \count($verified));
    }

    public function testATamperedArtifactIsRejected(): void
    {
        $scratch = TestEnvironment::makeTempDirectory('eszter-artifacts');

        try {
            foreach (glob(TestEnvironment::contractsDirectory() . '/*.json') ?: [] as $file) {
                copy($file, $scratch . '/' . basename($file));
            }

            $target = $scratch . '/semantic-rules.json';
            file_put_contents($target, file_get_contents($target) . "\n");

            $this->expectException(ContractArtifactException::class);
            $this->expectExceptionMessageMatches('/digest mismatch for semantic-rules\.json/');

            (new ContractArtifacts($scratch))->verifyAll();
        } finally {
            TestEnvironment::removeDirectory($scratch);
        }
    }

    public function testAMissingArtifactIsRejected(): void
    {
        $this->expectException(ContractArtifactException::class);

        (new ContractArtifacts(TestEnvironment::contractsDirectory() . '/nope'))->verifyAll();
    }

    public function testCanonicalSiteContentIsTheDocumentStorageSeedsFrom(): void
    {
        $artifacts = TestEnvironment::artifacts();
        $content = $artifacts->canonicalSiteContent();

        // Same bytes the corpus declares as its base — the assertion that keeps
        // "seed from defaults" and "the corpus base" from becoming two documents.
        self::assertSame($artifacts->parityCorpus()['bases']['siteContent'], $content);

        $result = ContentValidator::create($artifacts)
            ->validate($content, ContentValidator::TARGET_SITE_CONTENT);

        self::assertTrue($result->valid, $result->summary());
    }

    public function testContentSchemaVersionIsTheFrozenOne(): void
    {
        self::assertSame(1, TestEnvironment::artifacts()->contentSchemaVersion());
    }
}
