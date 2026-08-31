<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** A half-open UTC resource interval that blocks new appointments. */
final class OccupiedInterval
{
    public function __construct(
        public readonly \DateTimeImmutable $startsAtUtc,
        public readonly \DateTimeImmutable $endsAtUtc,
    ) {
        if ($endsAtUtc <= $startsAtUtc) {
            throw new BookingValidationException('occupiedInterval', 'Occupied interval must be increasing.');
        }
    }
}
