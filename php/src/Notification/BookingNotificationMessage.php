<?php

declare(strict_types=1);

namespace Eszter\Notification;

/** Deterministic rendered content, independent from its delivery mechanism. */
final class BookingNotificationMessage
{
    public function __construct(
        public readonly string $subject,
        public readonly string $text,
        public readonly string $html,
    ) {
    }
}
