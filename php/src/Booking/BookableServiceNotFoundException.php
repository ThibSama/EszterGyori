<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** The requested stable service key has no provisioned booking configuration. */
final class BookableServiceNotFoundException extends \RuntimeException
{
    public function __construct(public readonly string $serviceKey)
    {
        parent::__construct("No bookable service is provisioned for {$serviceKey}.");
    }
}
