<?php

declare(strict_types=1);

namespace Eszter\Storage;

/**
 * The one thing `GET /api/content` needs from storage.
 *
 * The route depends on this rather than on {@see ContentStorage} so the HTTP
 * conformance suite can replay the contract's `storage: failure` and
 * `storage: malformed` cases against the real route. Simulating those through the
 * filesystem would mean writing a corrupt file and trusting that it produces the
 * failure the case names; an injected reader raises exactly the failure under
 * test. It mirrors the seam the reference implementation used, so both runtimes
 * replay the same cases the same way.
 */
interface PublishedContentReader
{
    /**
     * @return array<string, mixed> The validated, normalised published envelope.
     * @throws StorageException When the envelope cannot be read or does not validate.
     */
    public function readPublished(): array;
}
