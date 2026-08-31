<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * The catalogue does not carry the requested asset (ESZ-037).
 *
 * Raised for an id that is well-formed and unknown. An id that is *not*
 * well-formed never reaches the library through the HTTP endpoint: the generated
 * request schema refuses it with 400 `VALIDATION_FAILED`. A well-formed id absent
 * from the catalogue is the distinct 404 case represented here.
 */
final class MediaMissingException extends \RuntimeException
{
    public function __construct(public readonly string $assetId)
    {
        parent::__construct("No media asset is catalogued under {$assetId}.");
    }
}
