<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** No persisted booking carries the requested opaque reference. */
final class BookingNotFoundException extends \RuntimeException
{
    public function __construct(public readonly string $reference)
    {
        parent::__construct("No booking exists under reference {$reference}.");
    }
}
