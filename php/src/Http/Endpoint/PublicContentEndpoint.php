<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Contract\ContentValidator;
use Eszter\Http\EntityTag;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Storage\PublishedContentReader;
use Eszter\Storage\StorageException;

/**
 * `GET /api/content` (ESZ-014).
 *
 * Serves the published envelope, revalidated on the way out.
 *
 * ## Validated before sending, not only after loading
 *
 * The envelope is validated again here even though the reader already validated
 * what it read. The reference implementation does the same, and the reason is
 * that the frontend silently falls back to default content when a response fails
 * its own schema check: a drifted response does not raise anywhere, it just makes
 * the site quietly show defaults. Re-validating turns that into a loud 500 that
 * someone can actually find. The cost is one validation of an ~8 kB document.
 *
 * ## Failures are opaque and identical
 *
 * A storage failure and a response that fails validation collapse to the same
 * 500 `STORAGE_FAILURE`, with no path, file name or schema detail in the body.
 * Distinguishing them would tell an anonymous caller which of the two happened,
 * and the caller can do nothing with either. The distinction is kept in the log,
 * where it is useful.
 *
 * ## Caching
 *
 * `ETag: "published-<revision>"`, `Cache-Control` from the contract, both on 200
 * and on 304. The revision is the only input to the tag, so a write that changes
 * content without bumping it leaves caches serving the old document — a property
 * of the contract, not of this handler.
 */
final class PublicContentEndpoint
{
    public const PATH = '/api/content';

    public function __construct(
        private readonly PublishedContentReader $reader,
        private readonly ContentValidator $validator,
        private readonly EntityTag $etags,
        private readonly string $cacheControl,
    ) {
    }

    public function __invoke(Request $request): Response
    {
        $envelope = $this->readValidatedEnvelope();
        $etag = $this->etags->forRevision($this->revisionOf($envelope));

        $headers = ['ETag' => $etag, 'Cache-Control' => $this->cacheControl];

        // A 304 keeps the caching headers and carries no body at all — not an
        // empty JSON object, not a Content-Type.
        if ($this->etags->ifNoneMatchSelects($request->header('if-none-match'), $etag)) {
            return Response::empty(304, $headers);
        }

        return Response::json(200, $envelope, $headers);
    }

    /**
     * @return array<string, mixed>
     * @throws StorageException Opaque to the caller; detailed in the log.
     */
    private function readValidatedEnvelope(): array
    {
        $envelope = $this->reader->readPublished();

        $result = $this->validator->validate($envelope, ContentValidator::TARGET_PUBLISHED_ENVELOPE);

        if (!$result->valid || !\is_array($result->value)) {
            throw new StorageException(
                StorageException::VALIDATION_FAILED,
                'Published envelope failed contract validation on the response path: '
                    . $result->summary(),
                'published',
            );
        }

        /** @var array<string, mixed> */
        return $result->value;
    }

    /** @param array<string, mixed> $envelope */
    private function revisionOf(array $envelope): int
    {
        /** @var mixed $revision */
        $revision = $envelope['revision'] ?? null;

        if (!\is_int($revision) || $revision < 0) {
            // Unreachable through the validator above, which pins revision to a
            // non-negative integer. Stated anyway so the ETag can never be built
            // from something that is not one.
            throw new StorageException(
                StorageException::VALIDATION_FAILED,
                'Published envelope carries no usable revision.',
                'published',
            );
        }

        return $revision;
    }
}
