<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Booking\Booking;
use Eszter\Support\Clock;

/** Atomic booking lifecycle → durable e-mail job producer (ESZ-074). */
final class DurableBookingNotificationProducer implements BookingNotificationProducer
{
    private const REMINDER_LEAD_HOURS = 24;

    public function __construct(
        private readonly NotificationScheduler $scheduler,
        private readonly NotificationJobRepository $jobs,
        private readonly Clock $clock,
    ) {
    }

    public function created(Booking $booking): void
    {
        $this->scheduler->schedule(
            $booking->id,
            $booking->reference,
            'email',
            'booking_confirmation',
            $this->clock->now(),
        );
        $this->scheduleReminder($booking);
    }

    public function moved(Booking $before, Booking $after): void
    {
        $oldStart = self::instant($before->startsAtUtc);
        $this->jobs->supersedePendingReminders(
            $before->id,
            'reminder_superseded',
            $oldStart->modify('-' . self::REMINDER_LEAD_HOURS . ' hours'),
        );
        $newStart = self::instant($after->startsAtUtc);
        $this->scheduler->schedule(
            $after->id,
            $after->reference,
            'email',
            'booking_moved',
            $this->clock->now(),
            $newStart,
        );
        $this->scheduleReminder($after);
    }

    public function cancelled(Booking $booking): void
    {
        $this->jobs->supersedePendingReminders($booking->id, 'booking_cancelled');
        $this->scheduler->schedule(
            $booking->id,
            $booking->reference,
            'email',
            'booking_cancellation',
            $this->clock->now(),
        );
    }

    private function scheduleReminder(Booking $booking): void
    {
        $this->scheduler->schedule(
            $booking->id,
            $booking->reference,
            'email',
            'booking_reminder',
            self::instant($booking->startsAtUtc)->modify('-' . self::REMINDER_LEAD_HOURS . ' hours'),
        );
    }

    private static function instant(string $databaseInstant): \DateTimeImmutable
    {
        $instant = \DateTimeImmutable::createFromFormat(
            '!Y-m-d H:i:s.v',
            $databaseInstant,
            new \DateTimeZone('UTC'),
        );
        if (!$instant instanceof \DateTimeImmutable) {
            throw new NotificationException('Booking start instant is malformed.');
        }

        return $instant;
    }
}
