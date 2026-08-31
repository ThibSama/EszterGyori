<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** A state change is outside the centrally frozen V1 transition graph. */
final class InvalidBookingTransitionException extends \DomainException
{
    public function __construct(
        public readonly string $from,
        public readonly string $to,
    ) {
        parent::__construct("Booking state cannot transition from {$from} to {$to}.");
    }
}
