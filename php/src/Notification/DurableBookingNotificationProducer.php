<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Booking\Booking;
use Eszter\Support\Clock;

/**
 * Atomic booking lifecycle → durable e-mail job producer (ESZ-074).
 *
 * ESZ-131: the lifecycle notifications themselves are superseded, not only the
 * reminders. Each lifecycle transition first terminally supersedes the pending
 * jobs the transition proves obsolete — a move retires any pending confirmation
 * and any pending earlier move, a cancellation retires both — then schedules
 * its own job. Every lifecycle job records the booking_history id of the event
 * that makes it meaningful (`$lifecycleEventId`), so a job that was already
 * claimed when the next transition committed is re-checked against that same
 * ordering at delivery time instead of being rendered with current facts under
 * an obsolete event type.
 */
final class DurableBookingNotificationProducer implements BookingNotificationProducer
{
    /** ESZ-161 — the single reminder is due this long before the appointment (booking-domain notifications.reminders). */
    private const REMINDER_LEAD_HOURS = 24;

    public function __construct(
        private readonly NotificationScheduler $scheduler,
        private readonly NotificationJobRepository $jobs,
        private readonly Clock $clock,
        /**
         * ESZ-161 — the existing `notifications.channels` setting decides
         * whether an SMS reminder may be pending. Null (a caller that never
         * enables SMS) schedules e-mail only.
         */
        private readonly ?EnabledChannels $channels = null,
    ) {
    }

    public function created(Booking $booking, int $lifecycleEventId): void
    {
        $this->scheduler->schedule(
            $booking->id,
            $booking->reference,
            'email',
            'booking_confirmation',
            $this->clock->now(),
            null,
            $lifecycleEventId,
        );
        $this->scheduleReminder($booking);
    }

    public function moved(Booking $before, Booking $after, int $lifecycleEventId): void
    {
        $oldStart = self::instant($before->startsAtUtc);
        $this->jobs->supersedePendingReminders(
            $before->id,
            'reminder_superseded',
            $oldStart->modify('-' . self::REMINDER_LEAD_HOURS . ' hours'),
        );
        // ESZ-131: the move itself makes every still-pending earlier lifecycle
        // notification obsolete — the confirmation of the pre-move appointment,
        // and any earlier move the customer was never told about. Superseding
        // them in this same transaction is what guarantees only the newest
        // applicable move can ever deliver.
        $this->jobs->supersedePendingLifecycleJobs($before->id, 'superseded_by_move');
        $newStart = self::instant($after->startsAtUtc);
        $this->scheduler->schedule(
            $after->id,
            $after->reference,
            'email',
            'booking_moved',
            $this->clock->now(),
            $newStart,
            $lifecycleEventId,
        );
        $this->scheduleReminder($after);
    }

    public function cancelled(Booking $booking, int $lifecycleEventId): void
    {
        $this->jobs->supersedePendingReminders($booking->id, 'booking_cancelled');
        // ESZ-131: the cancellation retires the pending confirmation and any
        // pending move. The cancellation job itself is terminal by state: no
        // lifecycle transition can follow a cancellation.
        $this->jobs->supersedePendingLifecycleJobs($booking->id, 'superseded_by_cancellation');
        $this->scheduler->schedule(
            $booking->id,
            $booking->reference,
            'email',
            'booking_cancellation',
            $this->clock->now(),
            null,
            $lifecycleEventId,
        );
    }

    /**
     * One reminder at T-24h. E-mail always; SMS only when the customer chose
     * to give a phone *and* the sms channel is enabled in the existing
     * `notifications.channels` setting (off by default, never enabled by the
     * application). A booking without a phone has no SMS recipient, so no
     * SMS row is written for it at all — this is not a declined notification
     * but one that was never intended (ESZ-161, booking-domain
     * notifications.reminders).
     */
    private function scheduleReminder(Booking $booking): void
    {
        $dueAt = self::instant($booking->startsAtUtc)->modify('-' . self::REMINDER_LEAD_HOURS . ' hours');
        $this->scheduler->schedule($booking->id, $booking->reference, 'email', 'booking_reminder', $dueAt);
        if ($booking->customerPhone !== null && $this->channels?->isEnabled('sms') === true) {
            $this->scheduler->schedule($booking->id, $booking->reference, 'sms', 'booking_reminder', $dueAt);
        }
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
