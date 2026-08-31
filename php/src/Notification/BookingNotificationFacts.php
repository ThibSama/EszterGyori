<?php

declare(strict_types=1);

namespace Eszter\Notification;

/** Typed booking facts consumed by templates; no template can query storage. */
final class BookingNotificationFacts
{
    public function __construct(
        public readonly string $recipientAddress,
        public readonly string $serviceLabel,
        public readonly \DateTimeImmutable $startsAtUtc,
        public readonly string $bookingReference,
        public readonly string $jobType,
    ) {
    }
}
