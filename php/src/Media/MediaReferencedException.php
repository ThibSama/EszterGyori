<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * A delete was refused because the asset is still in use (ESZ-037).
 *
 * Its own type rather than a boolean return, because the refusal has to travel
 * out of a closure running under the library's exclusive lock, and because it is
 * not an error in the sense the other exceptions are: nothing failed, the request
 * was simply not allowed to proceed. The endpoint turns it into 409
 * `MEDIA_REFERENCED`.
 *
 * It carries the id and nothing else. Naming the *document* that references the
 * asset, or the field inside it, would put content structure into an error
 * envelope; the admin already has the CMS in front of them and can see where the
 * image is used.
 */
final class MediaReferencedException extends \RuntimeException
{
    public function __construct(public readonly string $assetId)
    {
        parent::__construct("Media asset {$assetId} is still referenced by content.");
    }
}
