<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** A booking-domain value was invalid before any persistence was attempted. */
class BookingValidationException extends \InvalidArgumentException
{
    public function __construct(
        public readonly string $field,
        string $message,
    ) {
        parent::__construct($message);
    }
}
