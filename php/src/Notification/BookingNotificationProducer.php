<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Booking\Booking;

/** Booking lifecycle producer seam, kept inside each booking transaction. */
interface BookingNotificationProducer
{
    public function created(Booking $booking): void;

    public function moved(Booking $before, Booking $after): void;

    public function cancelled(Booking $booking): void;
}
