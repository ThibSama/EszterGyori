<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;

/**
 * The one authoritative booking serialization boundary (ESZ-047/048/146).
 *
 * Every operation whose outcome depends on bookability — booking create and
 * move, cancellation, weekly availability replacement, date exception
 * open/close/remove and bookable-service provisioning that changes
 * `is_active`, duration or buffers — takes the same singleton row
 * (`booking_resource_locks.primary`) with a locking read as its first
 * statement inside its own transaction. The first operation to acquire the
 * row is ordered first; one that finds a mutation already committed then
 * re-reads the new service/availability state and can confirm a booking only
 * if the requested slot is still valid.
 *
 * The lock is a plain MySQL row lock, so it works on InnoDB shared hosting
 * without Redis, a daemon or any process-local mutex, and it serializes
 * across every PHP process and host.
 *
 * Callers must acquire it inside their owning transaction and before any
 * other mutable row lock, preserving the single order:
 * `booking_resource_locks.primary` -> availability revision / service /
 * booking rows -> writes.
 */
final class BookingSerializationLock
{
    public function __construct(private readonly Database $database)
    {
    }

    public function acquire(): void
    {
        $row = $this->database->fetchOne(
            "SELECT resource_key FROM booking_resource_locks WHERE resource_key = 'primary' FOR UPDATE",
        );
        if (($row['resource_key'] ?? null) !== 'primary') {
            throw new \RuntimeException('The booking serialization row is missing.');
        }
    }
}
