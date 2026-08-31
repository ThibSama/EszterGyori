<?php

declare(strict_types=1);

namespace Eszter\Booking;

final class BookingHistoryEvent
{
    /** @param array<string, mixed> $details */
    public function __construct(
        public readonly int $id,
        public readonly int $bookingId,
        public readonly string $type,
        public readonly string $actor,
        public readonly array $details,
        public readonly string $occurredAt,
    ) {
    }
}
