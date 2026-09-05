<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Booking\Booking;

/** Booking lifecycle producer seam, kept inside each booking transaction. */
interface BookingNotificationProducer
{
    /**
     * @param int $lifecycleEventId ESZ-131 — the booking_history id of the
     *     `created` event this confirmation belongs to.
     */
    public function created(Booking $booking, int $lifecycleEventId): void;

    /**
     * @param int $lifecycleEventId ESZ-131 — the booking_history id of the
     *     `moved` event this notification belongs to.
     */
    public function moved(Booking $before, Booking $after, int $lifecycleEventId): void;

    /**
     * @param int $lifecycleEventId ESZ-131 — the booking_history id of the
     *     `cancelled` event this notification belongs to.
     */
    public function cancelled(Booking $booking, int $lifecycleEventId): void;
}
