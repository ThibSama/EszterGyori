<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** One canonical row of booking-specific service configuration (ESZ-041). */
final class BookableService
{
    public function __construct(
        public readonly string $key,
        public readonly string $label,
        public readonly int $durationMinutes,
        public readonly int $bufferBeforeMinutes,
        public readonly int $bufferAfterMinutes,
        public readonly bool $isActive,
        public readonly string $createdAt,
        public readonly string $updatedAt,
    ) {
    }

    /** @param array<string, mixed> $row */
    public static function fromRow(array $row): self
    {
        $key = $row['service_key'] ?? null;
        $label = $row['booking_label'] ?? null;
        $duration = $row['duration_minutes'] ?? null;
        $before = $row['buffer_before_minutes'] ?? null;
        $after = $row['buffer_after_minutes'] ?? null;
        $active = $row['is_active'] ?? null;
        $created = $row['created_at'] ?? null;
        $updated = $row['updated_at'] ?? null;

        if (
            !\is_string($key) || !\is_string($label) || !\is_int($duration)
            || !\is_int($before) || !\is_int($after)
            || !\is_string($created) || !\is_string($updated)
        ) {
            throw new \RuntimeException('booking_services row is malformed.');
        }

        return new self(
            $key,
            $label,
            $duration,
            $before,
            $after,
            $active === 1 || $active === '1' || $active === true,
            $created,
            $updated,
        );
    }
}
