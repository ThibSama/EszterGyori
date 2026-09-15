<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * What one reservation is *for* (ESZ-150): a single active service, or a
 * bookable combination of services — implicit under the default-allow rule
 * or shaped by a stored override.
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
     * The effective duration and buffers of a combination — the summed
     * default, or the custom duration and its snapshotted buffers when the
     * membership carries an override. The policy has already decided
     * bookability; nothing is re-derived here.
     */
    public static function ofCombination(EffectiveCombination $combination): self
    {
        return new self(
            $combination->serviceKeys,
            $combination->serviceKeys[0],
            $combination->key,
            $combination->durationMinutes,
            $combination->bufferBeforeMinutes,
            $combination->bufferAfterMinutes,
            $combination->bookable,
        );
    }

    /**
     * ESZ-153 — the same identity with a booking's own frozen shape.
     *
     * A confirmed booking moves as what it *is*: its stored services (the
     * identity this offer resolved, still required to be bookable under the
     * current catalog policy), its stored duration and its snapshotted
     * buffers — never the duration or buffers the catalog configures later.
     * The slot engine reads only the shaping facts, so the result is the one
     * input it needs to move that booking without a second engine.
     */
    public function frozenAs(int $durationMinutes, BookingBufferSnapshot $buffers): self
    {
        if ($durationMinutes < 1) {
            throw new BookingValidationException('durationMinutes', 'A booking duration must be positive.');
        }

        return new self(
            $this->serviceKeys,
            $this->serviceKey,
            $this->combinationKey,
            $durationMinutes,
            $buffers->bufferBeforeMinutes,
            $buffers->bufferAfterMinutes,
            $this->isActive,
        );
    }
}
