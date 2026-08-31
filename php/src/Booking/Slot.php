<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** One computed candidate. It is never persisted. */
final class Slot
{
    public function __construct(
        public readonly string $localDate,
        public readonly string $localStart,
        public readonly ?string $foldUtcOffset,
        public readonly \DateTimeImmutable $startsAtUtc,
        public readonly \DateTimeImmutable $endsAtUtc,
    ) {
    }
}
