<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * How a catalog write that persists a managed image reference is made safe
 * against the media library (ESZ-149).
 *
 * The booking domain stores the image as a public media path and nothing
 * else; it does not know the media contract, the catalogue or the
 * media/content lock boundary. The composition root supplies an
 * implementation that does (`Eszter\Media\ManagedServiceImageReferencePolicy`)
 * and the repository runs every write that can make a reference durable
 * through {@see withImageReference()}, which:
 *
 *  - refuses a path the catalogue does not carry, before the write; and
 *  - holds the media/content boundary shared across the whole write, so a
 *    concurrent media delete either observes the committed reference and
 *    refuses, or completes before the reference exists — never in between.
 *
 * `NullServiceImageReferencePolicy` is the no-image-capable default for
 * contexts without a media library (the operator CLI, the SQL suites): it
 * admits only a null reference and runs the operation unchanged.
 */
interface ServiceImageReferencePolicy
{
    /**
     * @template T
     * @param \Closure(): T $operation The write to run under the policy.
     * @return T
     * @throws BookingValidationException When `$imageSrc` is not a reference
     *         this policy can make durable.
     */
    public function withImageReference(?string $imageSrc, \Closure $operation): mixed;
}
