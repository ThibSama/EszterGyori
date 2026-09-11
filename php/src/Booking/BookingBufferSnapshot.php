<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * ESZ-153 — the before/after buffers one booking was confirmed with, as its
 * own `booking_buffer_snapshots` row holds them.
 *
 * Written once beside the booking and never updated, so the interval the
 * booking occupies — `starts_at_utc - before` to `ends_at_utc + after` — is
 * a function of the booking's own row and this one, never of the catalog as
 * it is later configured. `origin` says whether the booking captured its
 * own confirmation offer (`offer`) or was frozen by the ESZ-153 legacy
 * backfill / restore reconciliation (`legacy`).
 */
final class BookingBufferSnapshot
{
    public const ORIGIN_OFFER = 'offer';
    public const ORIGIN_LEGACY = 'legacy';

    public function __construct(
        public readonly int $bufferBeforeMinutes,
        public readonly int $bufferAfterMinutes,
        public readonly string $origin,
    ) {
        if ($bufferBeforeMinutes < 0 || $bufferAfterMinutes < 0) {
            throw new BookingValidationException('bufferSnapshot', 'Buffer snapshot minutes cannot be negative.');
        }
        if ($origin !== self::ORIGIN_OFFER && $origin !== self::ORIGIN_LEGACY) {
            throw new BookingValidationException('bufferSnapshot', 'Unknown buffer snapshot origin.');
        }
    }

    /** @param array<string, mixed> $row */
    public static function fromRow(array $row): self
    {
        $before = $row['buffer_before_minutes'] ?? null;
        $after = $row['buffer_after_minutes'] ?? null;
        $origin = $row['origin'] ?? null;
        if ((!\is_int($before) && !\is_string($before)) || (!\is_int($after) && !\is_string($after))) {
            throw new \RuntimeException('booking_buffer_snapshots row is malformed.');
        }
        if (!\is_string($origin)) {
            throw new \RuntimeException('booking_buffer_snapshots row has no origin.');
        }

        return new self((int) $before, (int) $after, $origin);
    }
}
