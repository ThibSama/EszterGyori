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
        $serviceKey = BookingRequestFields::requiredString($request, 'serviceKey');
        $fromDate = BookingRequestFields::requiredString($request, 'fromDate');
        $untilDate = BookingRequestFields::requiredString($request, 'untilDate');
        $this->assertRange($fromDate, $untilDate);
        $service = $this->catalog->requireActive($serviceKey);
        $slots = $this->compute($service, $fromDate, $untilDate);

        return $this->availabilityEnvelope($service, $fromDate, $untilDate, $slots);
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
        $service = $this->catalog->requireActive($booking->serviceKey);

        return $this->availabilityEnvelope(
            $service,
            $fromDate,
            $untilDate,
            $this->compute($service, $fromDate, $untilDate, $reference),
        );
    }

    /**
     * Revalidates one requested start instant against the schedule as it is
     * now, excluding the caller's own booking when one is being moved.
     *
     * The caller (a booking command) holds the serialization boundary and is
     * inside its transaction: this runs after any committed availability or
     * service mutation, so a slot that disappeared can never be confirmed.
     * The service is re-resolved through the catalogue's single active rule
     * before any slot is generated.
     *
     * @throws SlotUnavailableException when the schedule no longer offers the
     *     requested instant
     */
    public function requestedSlot(
        string $serviceKey,
        string $localDate,
        \DateTimeImmutable $requestedStart,
        ?string $excludeReference = null,
    ): Slot {
        $service = $this->catalog->requireActive($serviceKey);
        foreach ($this->compute($service, $localDate, $localDate, $excludeReference) as $slot) {
            if (IsoTimestamp::format($slot->startsAtUtc) === IsoTimestamp::format($requestedStart)) {
                return $slot;
            }
        }

        throw new SlotUnavailableException('Requested slot failed transactional revalidation.');
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
        BookableService $service,
        string $fromDate,
        string $untilDate,
        array $slots,
    ): array {
        return [
            'serviceKey' => $service->key,
            'timezone' => $this->contract->timezone,
            'fromDate' => $fromDate,
            'untilDate' => $untilDate,
            'slots' => array_map($this->slotPayload(...), $slots),
        ];
    }

    /** @return list<Slot> */
    private function compute(
        BookableService $service,
        string $fromDate,
        string $untilDate,
        ?string $excludeReference = null,
    ): array {
        [$fromUtc, $untilUtc] = $this->utcDayRange($fromDate, $untilDate);

        return $this->engine->generate(
            $service,
            $fromDate,
            $untilDate,
            $this->availabilityRepository->weeklyRules(),
            $this->availabilityRepository->exceptionsBetween($fromDate, $untilDate),
            $this->bookings->occupiedBetween($fromUtc, $untilUtc, $excludeReference),
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
