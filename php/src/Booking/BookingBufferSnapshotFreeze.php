<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;

/**
 * ESZ-153 — the legacy freeze, as application code.
 *
 * Migration 0019 freezes every booking that predates the snapshot table to
 * the effective buffers authoritative for it at that instant. The same
 * statement is needed once more, outside any migration: a backup archive
 * taken before ESZ-153 carries bookings but no snapshot rows, and the
 * restore imports it into an already migrated schema. Running this after the
 * import gives those bookings the same deterministic freeze the migration
 * gave the live ones — current combination buffers when the booking names a
 * combination, otherwise current service buffers — and touches no booking
 * that already owns a snapshot (`INSERT IGNORE` on the booking-id key).
 *
 * It rewrites nothing: service identity, start, end, state and history stay
 * exactly as imported.
 */
final class BookingBufferSnapshotFreeze
{
    /** @return int the number of bookings frozen by this call */
    public static function apply(Database $database): int
    {
        return $database->run(
            'INSERT IGNORE INTO booking_buffer_snapshots'
            . ' (booking_id, buffer_before_minutes, buffer_after_minutes, origin, frozen_at)'
            . ' SELECT b.id,'
            . ' COALESCE(c.buffer_before_minutes, s.buffer_before_minutes),'
            . ' COALESCE(c.buffer_after_minutes, s.buffer_after_minutes),'
            // The freeze instant is MySQL's own UTC clock, in the canonical
            // ISO form every audit column uses — the same expression as the
            // migration, so a restored freeze and a deployed one read alike.
            . " :origin, CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%f'), 23), 'Z')"
            . ' FROM bookings b'
            . ' INNER JOIN booking_services s ON s.service_key = b.service_key'
            . ' LEFT JOIN booking_service_combinations c ON c.combination_key = b.combination_key',
            ['origin' => BookingBufferSnapshot::ORIGIN_LEGACY],
        )->rowCount();
    }
}
