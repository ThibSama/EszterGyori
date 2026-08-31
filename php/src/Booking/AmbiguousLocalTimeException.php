<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** The wall time occurs twice at DST fall-back and needs an explicit offset. */
final class AmbiguousLocalTimeException extends BookingValidationException
{
    public function __construct(string $localTime)
    {
        parent::__construct(
            'utcOffset',
            "Local time {$localTime} occurs twice in Europe/Paris; supply its numeric UTC offset.",
        );
    }
}
