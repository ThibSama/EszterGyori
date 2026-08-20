<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Contract\ContractArtifacts;
use Eszter\Storage\PublishedContentReader;
use Eszter\Storage\StorageException;

/**
 * The `storage` fixture the HTTP contract cases ask for, as a reader.
 *
 * `http-contract.json` says a case runs against storage that is `ok`, `failure`
 * or `malformed`. Producing those through the filesystem would mean writing a
 * corrupt file and *hoping* it triggers the failure the case names; here each one
 * is raised directly, so the case tests the route's handling rather than the
 * test's ability to corrupt a file convincingly. It is the same seam the
 * reference implementation's runner uses, so both runtimes replay the corpus the
 * same way.
 */
final class FixturePublishedContentReader implements PublishedContentReader
{
    public function __construct(
        private readonly ContractArtifacts $artifacts,
        private readonly string $storage,
        private readonly int $revision,
        private readonly string $publishedAt = '2026-06-13T12:00:00.000Z',
    ) {
    }

    /** @return array<string, mixed> */
    public function readPublished(): array
    {
        if ($this->storage === 'failure') {
            throw new StorageException(
                StorageException::READ_FAILED,
                'Synthetic storage failure.',
                'published',
            );
        }

        if ($this->storage === 'malformed') {
            // Structurally wrong in the way a hand-edited file usually is: the
            // right keys, a value of the wrong type. It must reach the route and
            // fail there, not be caught by the fixture.
            return ['schemaVersion' => 1, 'revision' => 'invalid'];
        }

        return [
            'schemaVersion' => $this->artifacts->contentSchemaVersion(),
            'revision' => $this->revision,
            'publishedAt' => $this->publishedAt,
            'content' => $this->artifacts->canonicalSiteContent(),
        ];
    }
}
