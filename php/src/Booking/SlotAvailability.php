<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * Slot availability: the public availability read, the move-availability
 * read and the transactional slot revalidation the booking commands run under
 * their serialization boundary (ESZ-106).
 *
 * This is the single owner of the availability-side rules the API exposes:
 * the public range/horizon check, the conversion of an inclusive local day
 * range into the UTC window slot generation works on, and the slot read that
 * refuses to confirm a requested instant that the current schedule no longer
 * offers. It only reads; every write stays in the repositories, and the
 * booking commands alone decide when a lock-protected revalidation runs.
 */
final class SlotAvailability
{
    public function __construct(
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
        private readonly Clock $clock,
        private readonly BookingServiceCatalog $catalog,
        private readonly AvailabilityRepository $availabilityRepository,
        private readonly BookingRepository $bookings,
        private readonly SlotEngine $engine,
    ) {
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function availability(array $request): array
    {
        $serviceKeys = BookingRequestFields::serviceKeys($request);
        $fromDate = BookingRequestFields::requiredString($request, 'fromDate');
        $untilDate = BookingRequestFields::requiredString($request, 'untilDate');
        $this->assertRange($fromDate, $untilDate);
        // ESZ-150: one key or a combination — the catalog's single resolver
        // decides. A set of active services within the configured maximum is
        // bookable by default; only an explicitly disabled membership (or an
        // archived member, or too many) is refused, before any slot is
        // computed.
        $offer = $this->catalog->requireOffer($serviceKeys);
        $slots = $this->compute($offer, $fromDate, $untilDate);

        return $this->availabilityEnvelope($offer, $fromDate, $untilDate, $slots);
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMoveAvailability(array $request): array
    {
        $reference = BookingRequestFields::requiredString($request, 'reference');
        $fromDate = BookingRequestFields::requiredString($request, 'fromDate');
        $untilDate = BookingRequestFields::requiredString($request, 'untilDate');
        $this->assertRange($fromDate, $untilDate);
        $booking = $this->bookings->find($reference);
        if ($booking === null) {
            throw new BookingNotFoundException($reference);
        }
        if ($booking->state->value !== 'confirmed') {
            throw new InvalidBookingTransitionException($booking->state->value, 'moved');
        }
        // ESZ-150/153: a booking moves as its stored services — frozen to
        // its own duration and buffer snapshot — and fails closed if that
        // service or combination is no longer bookable.
        $offer = $this->movableOffer($booking);

        return $this->availabilityEnvelope(
            $offer,
            $fromDate,
            $untilDate,
            $this->compute($offer, $fromDate, $untilDate, $reference),
        );
    }

    /**
     * Revalidates one requested start instant for a *new* booking against
     * the schedule as it is now.
     *
     * The caller (a booking command) holds the serialization boundary and is
     * inside its transaction: this runs after any committed availability or
     * service mutation, so a slot that disappeared can never be confirmed.
     * The offer is re-resolved through the catalogue's single bookability
     * rule before any slot is generated, and returned beside the slot so the
     * caller stores exactly what was revalidated (ESZ-150: the combination's
     * effective duration — summed by default, custom when overridden — its
     * key and its first member; ESZ-153: the buffers the booking snapshots
     * as its own). A move of an existing booking goes
     * through {@see requestedMoveSlot()} instead.
     *
     * @param list<string> $serviceKeys
     * @return array{offer: BookableOffer, slot: Slot}
     * @throws SlotUnavailableException when the schedule no longer offers the
     *     requested instant
     */
    public function requestedSlot(
        array $serviceKeys,
        string $localDate,
        \DateTimeImmutable $requestedStart,
    ): array {
        $offer = $this->catalog->requireOffer($serviceKeys);
        foreach ($this->compute($offer, $localDate, $localDate) as $slot) {
            if (IsoTimestamp::format($slot->startsAtUtc) === IsoTimestamp::format($requestedStart)) {
                return ['offer' => $offer, 'slot' => $slot];
            }
        }

        throw new SlotUnavailableException('Requested slot failed transactional revalidation.');
    }

    /**
     * ESZ-153 — the move-side revalidation: the same schedule, rules,
     * constraints and occupancy as {@see requestedSlot()}, computed for the
     * booking's own frozen shape rather than for the catalog's current one.
     * The caller holds the serialization boundary and the row lock.
     *
     * @throws SlotUnavailableException when the schedule no longer offers the
     *     requested instant for this booking
     */
    public function requestedMoveSlot(
        Booking $booking,
        string $localDate,
        \DateTimeImmutable $requestedStart,
    ): Slot {
        $offer = $this->movableOffer($booking);
        foreach ($this->compute($offer, $localDate, $localDate, $booking->reference) as $slot) {
            if (IsoTimestamp::format($slot->startsAtUtc) === IsoTimestamp::format($requestedStart)) {
                return $slot;
            }
        }

        throw new SlotUnavailableException('Requested slot failed transactional revalidation.');
    }

    /**
     * ESZ-153 — what an existing booking moves as.
     *
     * Bookability is the current catalog policy's (ESZ-150: the stored
     * service or combination and every member must still be active), but the
     * shape is the booking's own: its stored start→end duration and its
     * buffer snapshot. A duration or buffer configured after the confirmation
     * therefore reshapes new bookings and never this one — through the same
     * engine, since a frozen offer is just another offer to it.
     */
    private function movableOffer(Booking $booking): BookableOffer
    {
        return $this->catalog->requireOffer($booking->serviceKeys())->frozenAs(
            $booking->durationMinutes(),
            $this->bookings->bufferSnapshot($booking),
        );
    }

    /**
     * The public booking horizon: `[today, today + slotMaxHorizonDays - 1]`
     * in the site timezone, with a non-inverted, well-formed range.
     *
     * Every read or mutation that offers or confirms public booking slots
     * checks this rule here, before any transaction or side effect.
     */
    public function assertRange(string $fromDate, string $untilDate): void
    {
        BookingRequestFields::date($fromDate, 'fromDate');
        BookingRequestFields::date($untilDate, 'untilDate');
        $today = $this->clock->now()
            ->setTimezone(new \DateTimeZone($this->contract->timezone))
            ->format('Y-m-d');
        $last = BookingRequestFields::date($today, 'today')
            ->modify('+' . ($this->contract->slotMaxHorizonDays - 1) . ' days')
            ->format('Y-m-d');
        if ($untilDate < $fromDate || $fromDate < $today || $untilDate > $last) {
            throw new BookingValidationException('dateRange', 'Public booking range is outside the horizon.');
        }
    }

    /**
     * The UTC window of an inclusive local day range: from `00:00:00` local of
     * `$fromDate` to `00:00:00` local of the day after `$untilDate`, converted
     * with the Europe/Paris DST rules (a boundary local date may itself fall on
     * a transition day).
     *
     * @return array{\DateTimeImmutable, \DateTimeImmutable}
     */
    public function utcDayRange(string $fromDate, string $untilDate): array
    {
        $from = $this->time->localToUtcWithFoldOffset($fromDate . ' 00:00:00', null);
        $after = BookingRequestFields::date($untilDate, 'untilDate')->modify('+1 day')->format('Y-m-d');
        $until = $this->time->localToUtcWithFoldOffset($after . ' 00:00:00', null);

        return [$from, $until];
    }

    /**
     * @param list<Slot> $slots
     * @return array<string, mixed>
     */
    private function availabilityEnvelope(
        BookableOffer $offer,
        string $fromDate,
        string $untilDate,
        array $slots,
    ): array {
        return [
            'serviceKey' => $offer->serviceKey,
            'serviceKeys' => $offer->serviceKeys,
            'combinationKey' => $offer->combinationKey,
            'timezone' => $this->contract->timezone,
            'fromDate' => $fromDate,
            'untilDate' => $untilDate,
            'slots' => array_map($this->slotPayload(...), $slots),
        ];
    }

    /** @return list<Slot> */
    private function compute(
        BookableOffer $offer,
        string $fromDate,
        string $untilDate,
        ?string $excludeReference = null,
    ): array {
        [$fromUtc, $untilUtc] = $this->utcDayRange($fromDate, $untilDate);

        // ESZ-151: the stored booking-time rules and the current instant go
        // in beside the schedule, for the public read, the move read and the
        // revalidation alike — one persisted policy, one engine, no React copy.
        // ESZ-152: the stored planning constraints of the same window go in
        // beside them; the engine blocks on the strict ones and ignores pauses.
        return $this->engine->generate(
            $offer,
            $fromDate,
            $untilDate,
            $this->availabilityRepository->weeklyRules(),
            $this->availabilityRepository->exceptionsBetween($fromDate, $untilDate),
            $this->bookings->occupiedBetween($fromUtc, $untilUtc, $excludeReference),
            $this->clock->now(),
            $this->availabilityRepository->bookingTimeRules(),
            $this->availabilityRepository->constraintsBetween($fromDate, $untilDate),
        );
    }

    /** @return array<string, mixed> */
    private function slotPayload(Slot $slot): array
    {
        return [
            'localDate' => $slot->localDate,
            'localStart' => $slot->localStart,
            'foldUtcOffset' => $slot->foldUtcOffset,
            'startsAtUtc' => IsoTimestamp::format($slot->startsAtUtc),
            'endsAtUtc' => IsoTimestamp::format($slot->endsAtUtc),
        ];
    }
}
