<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * A stale admin editor tried to mutate a booking row (ESZ-139).
 *
 * The booking's `updatedAt` is its V1 optimistic-concurrency token. The API
 * layer compares the caller's `expectedUpdatedAt` byte-for-byte with the
 * current row under the authoritative row lock; a mismatch throws this before
 * any write, history append or notification scheduling, so the refusal leaves
 * the row, its history and the notification jobs exactly as they were.
 */
final class BookingRevisionConflictException extends \RuntimeException
{
    public function __construct(
        public readonly string $expectedUpdatedAt,
        public readonly string $currentUpdatedAt,
    ) {
        parent::__construct(\sprintf(
            'Expected booking updatedAt %s but the current updatedAt is %s.',
            $expectedUpdatedAt,
            $currentUpdatedAt,
        ));
    }

    /** @return array<string, string> Safe for the log. */
    public function logContext(): array
    {
        return [
            'expectedUpdatedAt' => $this->expectedUpdatedAt,
            'currentUpdatedAt' => $this->currentUpdatedAt,
        ];
    }
}
