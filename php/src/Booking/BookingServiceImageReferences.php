<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Media\MediaReferenceSource;

/**
 * The service catalog as a media reference source (ESZ-149): the media
 * delete route asks it whether any row — active or archived — still points
 * at the asset, and refuses the delete when one does. A plain read on the
 * catalog table; it holds no lock of its own and is consulted under the
 * delete's exclusive media/content boundary.
 */
final class BookingServiceImageReferences implements MediaReferenceSource
{
    public function __construct(private readonly BookableServiceRepository $services)
    {
    }

    public function references(string $publicPath): bool
    {
        return $this->services->referencesImage($publicPath);
    }
}
