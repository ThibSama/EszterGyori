<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * A content write would persist a managed media src the catalogue does not
 * carry (ESZ-147).
 *
 * Raised by {@see ManagedMediaReferenceGuard} when a document about to become
 * durable names a public path inside the managed namespace that no catalogue
 * entry matches exactly. Its own type rather than a boolean return, because
 * the refusal has to travel out of a closure running under the content
 * writer's exclusive lock, and because what it means depends on who is on the
 * other end:
 *
 *  - on the draft-save route the document was *submitted* by the caller, so
 *    the endpoint turns it into the caller's 400 `VALIDATION_FAILED`;
 *  - on the publish route the document is one already on disk, so the refusal
 *    is a fault of the service and the endpoint turns it into the opaque 500
 *    `STORAGE_FAILURE`.
 *
 * No new public error code is introduced; the two frozen outcomes are reused.
 * It carries the missing public paths and nothing about the document's
 * structure. The message names paths and is therefore log-only.
 */
final class DanglingMediaReferenceException extends \RuntimeException
{
    /**
     * @param list<string> $missingPaths The managed public paths that matched
     *        no catalogue entry, in document order.
     */
    public function __construct(public readonly array $missingPaths)
    {
        parent::__construct(
            'Content would persist managed media path(s) absent from the catalogue: '
                . \implode(', ', $missingPaths) . '.',
        );
    }
}
