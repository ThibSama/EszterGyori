<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * What one reservation is *for* (ESZ-150): a single active service, or a
 * validated, active combination of services.
 *
 * The slot engine reads the four shaping facts — duration, both buffers,
 * activity — and nothing else, so a combination and a service are the same
 * thing to it. Everything that has to be stored or echoed on the wire — the
 * canonical member keys, the first member (`serviceKey`, the booking row's
 * NOT NULL service reference) and the combination key (null for a single
 * service) — travels beside them. The catalog is the only place an offer is
 * built ({@see BookingServiceCatalog::requireOffer()}), so there is no way to
 * compute or confirm a slot for a selection the catalog did not approve.
 */
final class BookableOffer
{
    /** @param list<string> $serviceKeys canonical order */
    private function __construct(
        public readonly array $serviceKeys,
        public readonly string $serviceKey,
        public readonly ?string $combinationKey,
        public readonly int $durationMinutes,
        public readonly int $bufferBeforeMinutes,
        public readonly int $bufferAfterMinutes,
        public readonly bool $isActive,
    ) {
    }

    public static function ofService(BookableService $service): self
    {
        return new self(
            [$service->key],
            $service->key,
            null,
            $service->durationMinutes,
            $service->bufferBeforeMinutes,
            $service->bufferAfterMinutes,
            $service->isActive,
        );
    }

    /**
     * The validated duration and snapshotted buffers of the combination row;
     * bookable only while the row and every member are active.
     *
     * @param list<BookableService> $members in canonical order
     */
    public static function ofCombination(ServiceCombination $combination, array $members): self
    {
        $active = $combination->isActive;
        foreach ($members as $member) {
            $active = $active && $member->isActive;
        }

        return new self(
            $combination->serviceKeys,
            $combination->serviceKeys[0],
            $combination->key,
            $combination->durationMinutes,
            $combination->bufferBeforeMinutes,
            $combination->bufferAfterMinutes,
            $active,
        );
    }
}
