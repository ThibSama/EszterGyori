<?php

declare(strict_types=1);

namespace Eszter\Media;

use Eszter\Booking\BookingValidationException;
use Eszter\Booking\ServiceImageReferencePolicy;
use Eszter\Storage\MediaContentLock;

/**
 * The production image policy of the service catalog (ESZ-149): a service
 * may reference a managed media asset exactly the way a content document may.
 *
 * Reuses the ESZ-147 pieces rather than restating them:
 *
 *  - {@see MediaContract} decides that the path is inside the managed
 *    namespace (the frozen `publicPathPattern`), the only namespace a
 *    service image may name — an external URL or an arbitrary path is
 *    refused, so the back-office cannot reach past the media library;
 *  - {@see MediaLibrary::missingCataloguedPaths()} answers catalogue
 *    membership from the catalogue alone, never the filesystem;
 *  - the {@see MediaContentLock} boundary is held **shared** across the
 *    whole catalog write, the same way every content write holds it: a
 *    media delete, which needs the boundary exclusively, either observes
 *    the committed reference and refuses, or completes before the reference
 *    exists. It cannot land between the check and the commit.
 *
 * The lock order is media/content boundary, then the MySQL transaction and
 * its serialization row. The delete route takes the boundary first and only
 * then reads `booking_services` (a plain read, no row lock), so no cycle with
 * the catalog writer exists.
 */
final class ManagedServiceImageReferencePolicy implements ServiceImageReferencePolicy
{
    public function __construct(
        private readonly MediaContract $contract,
        private readonly MediaLibrary $library,
        private readonly MediaContentLock $boundary,
    ) {
    }

    /** @inheritDoc */
    public function withImageReference(?string $imageSrc, \Closure $operation): mixed
    {
        if ($imageSrc === null) {
            // Nothing becomes durable that the media library must protect.
            return $operation();
        }

        if (!$this->contract->isManagedPublicPath($imageSrc)) {
            throw new BookingValidationException(
                'imageSrc',
                'A service image must be a managed media path.',
            );
        }

        return $this->boundary->withShared(function () use ($imageSrc, $operation): mixed {
            if ($this->library->missingCataloguedPaths([$imageSrc]) !== []) {
                throw new BookingValidationException(
                    'imageSrc',
                    'The service image names no catalogued media asset.',
                );
            }

            return $operation();
        });
    }
}
