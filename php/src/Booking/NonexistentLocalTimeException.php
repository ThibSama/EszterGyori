<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** The wall time falls in the Europe/Paris spring-forward gap. */
final class NonexistentLocalTimeException extends BookingValidationException
{
    public function __construct(string $localTime)
    {
        parent::__construct('localTime', "Local time {$localTime} does not exist in Europe/Paris.");
    }
}
