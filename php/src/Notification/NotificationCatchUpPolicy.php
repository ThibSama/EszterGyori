<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Support\Clock;

/**
 * The catch-up decision, as a pure function of the frozen policy and the clock
 * (ESZ-072).
 *
 * Separated from {@see NotificationScheduler} deliberately. Everything here is
 * decidable without a database — "is this channel on", "has this window closed",
 * "what is this notification's stable identity" — and these are exactly the
 * rules that most need to be asserted on every run rather than only where MySQL
 * is available. The scheduler is then the thin part: ask this, write the answer.
 *
 * The policy it encodes is worth stating plainly, because it is the whole reason
 * the class exists. Every intended notification produces a row, always. A
 * declined one is written as terminally `skipped`, not dropped. That is what
 * makes the anti-backfill guarantee checkable instead of merely intended:
 * re-enabling a channel months later finds a table full of decisions nobody can
 * un-make, and a queue with nothing pending in it to burst.
 */
final class NotificationCatchUpPolicy
{
    public function __construct(
        private readonly EnabledChannels $channels,
        private readonly NotificationPolicy $policy,
        private readonly Clock $clock,
    ) {
    }

    /**
     * Builds the frozen idempotency key for one notification.
     *
     * Derived only from stable facts: the booking's opaque reference, the
     * channel, the type, and the due instant for types that recur. The same
     * intent therefore produces the same key on every process and every host,
     * which is what makes `enqueue` repeat-safe rather than merely
     * repeat-tolerant.
     *
     * The due instant is in the key for recurring types only, and that asymmetry
     * is load-bearing. A booking that is moved gets a genuinely different
     * reminder, and reusing the key would make the queue treat the new one as a
     * duplicate of the old. A confirmation, by contrast, is one per booking per
     * channel however often the appointment moves afterwards.
     */
    public function idempotencyKey(
        string $bookingReference,
        string $channel,
        string $jobType,
        \DateTimeImmutable $dueAt,
    ): string {
        $suffix = ($this->policy->isTimeSensitive($jobType) || $jobType === 'booking_moved')
            ? '.' . $dueAt->setTimezone(new \DateTimeZone('UTC'))->format('YmdHis')
            : '';

        $key = strtolower("{$bookingReference}.{$channel}.{$jobType}{$suffix}");
        $key = preg_replace('/[^a-z0-9_.:-]/', '-', $key) ?? $key;

        if (!$this->policy->acceptsIdempotencyKey($key)) {
            throw NotificationException::invalid('idempotencyKey', 'derived key is not usable.');
        }

        return $key;
    }

    /**
     * The whole decision: `pending` or `skipped`, and why.
     *
     * Order matters. A disabled channel is reported as a disabled channel even
     * when the window has also closed, because that is the fact an operator
     * turning SMS back on needs to see.
     *
     * @return array{status: string, errorCode: string|null}
     */
    public function decide(string $channel, string $jobType, \DateTimeImmutable $dueAt): array
    {
        if (!$this->channels->isEnabled($channel)) {
            return ['status' => 'skipped', 'errorCode' => 'channel_disabled'];
        }

        if ($this->isPastGraceWindow($jobType, $dueAt)) {
            return ['status' => 'skipped', 'errorCode' => 'reminder_window_expired'];
        }

        return ['status' => 'pending', 'errorCode' => null];
    }

    /**
     * True when a time-sensitive notification is already too late to be worth
     * sending.
     *
     * This is the same predicate the runner applies to claimed jobs, applied one
     * step earlier. Applying it here is what stops a backfill: a caller looping
     * over historical bookings to create reminders it never sent produces skips,
     * not a queue.
     */
    public function isPastGraceWindow(string $jobType, \DateTimeImmutable $dueAt): bool
    {
        if (!$this->policy->isTimeSensitive($jobType)) {
            return false;
        }

        $cutoff = $this->clock->now()->modify("-{$this->policy->reminderGraceMinutes} minutes");

        return $dueAt < $cutoff;
    }
}
