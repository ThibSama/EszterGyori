<?php

declare(strict_types=1);

namespace Eszter\Tests\Storage;

use Eszter\Storage\ExportedPageFile;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-084 — the carried "64 kB HTTP JSON vs 1 MB storage" question, settled.
 *
 * The two numbers were never in conflict; nothing said so, which is a different
 * defect and the one worth fixing. They bound different things, and the *direction*
 * of the inequality between them is what makes the pair safe. These assertions are
 * what keeps a later edit from inverting it by accident, since inverting it would
 * not fail anything else: a save would still be accepted, written, and only then
 * refused on the read that followed.
 */
final class StorageLimitReconciliationTest extends TestCase
{
    /**
     * @return array<mixed>
     */
    private function limits(): array
    {
        return TestEnvironment::artifacts()->storageLimits();
    }

    /**
     * The unsafe arrangement is the mirror image of this one.
     *
     * With the storage cap *below* the request limit, a document is accepted,
     * fsynced, renamed into place — and then refused by the very next read. The
     * editor's work is gone and the rule that destroyed it is the one that was
     * supposed to protect it. As long as the inequality points this way, the
     * request limit is the only ceiling anyone can reach.
     */
    public function testTheContentCapStaysAboveTheRequestLimit(): void
    {
        $contract = TestEnvironment::artifacts()->httpContract();

        /** @var int $requestLimit */
        $requestLimit = $contract['requestBodyLimitBytes'];
        $contentLimit = TestEnvironment::artifacts()->storageLimitBytes('contentFileLimitBytes');

        self::assertGreaterThan($requestLimit, $contentLimit);
        self::assertSame('contentFileLimitBytes > requestBodyLimitBytes', $this->limits()['invariant']);
    }

    /**
     * The whole document a request can carry still fits, with room to spare.
     *
     * Stated as arithmetic rather than as prose because the interesting quantity
     * is the *margin*: the canonical default is about 7.8 kB and the request limit
     * admits roughly eight times that, so the reachable file is a small fraction of
     * the cap even for a site far larger than this one.
     */
    public function testTheLargestWritableDocumentIsFarBelowTheReadGuard(): void
    {
        $artifacts = TestEnvironment::artifacts();
        $contract = $artifacts->httpContract();

        /** @var int $requestLimit */
        $requestLimit = $contract['requestBodyLimitBytes'];
        $contentLimit = $artifacts->storageLimitBytes('contentFileLimitBytes');

        // The stored envelope wraps the document in `revision` and `updatedAt`;
        // a kilobyte is a generous allowance for two scalars.
        $largestWritableFile = $requestLimit + 1024;

        self::assertGreaterThan($largestWritableFile * 8, $contentLimit);

        $default = (string) json_encode($artifacts->canonicalSiteContent());
        self::assertLessThan($requestLimit, \strlen($default));
    }

    /**
     * The exported page cap is spelled twice — a PHP constant and a contract
     * value — because the reader is constructed from paths alone. Two spellings
     * are acceptable only while something asserts they agree.
     */
    public function testTheExportedPageCapAgreesWithTheContract(): void
    {
        self::assertSame(
            ExportedPageFile::MAX_PAGE_BYTES,
            TestEnvironment::artifacts()->storageLimitBytes('exportedPageLimitBytes'),
        );
    }

    /**
     * The media catalogue is the only cap a caller can actually reach, so it is
     * the only one that has to be enforced before the write rather than on the
     * next read. `MediaLibraryCapTest` proves the behaviour; this proves the
     * contract still says so.
     */
    public function testOnlyTheReachableCapIsDeclaredEnforcedOnWrite(): void
    {
        self::assertSame(['mediaLibraryIndexLimitBytes'], $this->limits()['enforcedOnWrite']);
    }
}
