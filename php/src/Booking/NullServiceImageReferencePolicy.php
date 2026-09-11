<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * The image policy of a context with no media library (ESZ-149): only "no
 * image" can be stored, and nothing is locked. Named so that "cannot store an
 * image here" is visible in a stack rather than inferred from a missing object.
 */
final class NullServiceImageReferencePolicy implements ServiceImageReferencePolicy
{
    /** @inheritDoc */
    public function withImageReference(?string $imageSrc, \Closure $operation): mixed
    {
        if ($imageSrc !== null) {
            throw new BookingValidationException(
                'imageSrc',
                'No media library is available to resolve a service image reference.',
            );
        }

        return $operation();
    }
}
