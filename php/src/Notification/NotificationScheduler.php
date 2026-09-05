<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * Where an intended notification becomes a row (ESZ-072).
 *
 * Thin on purpose: it asks {@see NotificationCatchUpPolicy} what should happen
 * and writes the answer down through {@see NotificationJobRepository::enqueue()},
 * which is idempotent on the derived key. Every notification this application
 * intends to send goes through here, and every one of them produces exactly one
 * row — `pending` when it will be delivered, terminally `skipped` when it will
 * not.
 *
 * There is deliberately no path that writes nothing. A declined notification
 * that left no row would be indistinguishable later from one that was never
 * requested, and would leave open the possibility that some future code path
 * creates it after all.
 */
final class NotificationScheduler
{
    public function __construct(
        private readonly NotificationJobRepository $jobs,
        private readonly NotificationCatchUpPolicy $catchUp,
    ) {
    }

    /**
     * Records one intended notification and returns what was decided.
     *
     * @param int|null $lifecycleEventId ESZ-131 — for a lifecycle job, the
     *     booking_history id of the event that makes it meaningful; stored on
     *     the row so the runner can re-check relevance at delivery time.
     *     Reminders and declined enqueues carry none.
     * @return array{jobId: int, status: string, errorCode: string|null}
     */
    public function schedule(
        int $bookingId,
        string $bookingReference,
        string $channel,
        string $jobType,
        \DateTimeImmutable $dueAt,
        ?\DateTimeImmutable $identityAt = null,
        ?int $lifecycleEventId = null,
    ): array {
        $key = $this->catchUp->idempotencyKey(
            $bookingReference,
            $channel,
            $jobType,
            $identityAt ?? $dueAt,
        );
        $decision = $this->catchUp->decide($channel, $jobType, $dueAt);

        $jobId = $this->jobs->enqueue(
            $bookingId,
            $channel,
            $jobType,
            $key,
            $dueAt,
            $decision['status'],
            $decision['errorCode'],
            $lifecycleEventId,
        );

        return [
            'jobId' => $jobId,
            'status' => $decision['status'],
            'errorCode' => $decision['errorCode'],
        ];
    }
}
