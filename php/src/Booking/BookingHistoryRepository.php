<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/** Append-only audit facts; bookings remains the current-state authority. */
final class BookingHistoryRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
    ) {
    }

    /** @param array<string, mixed> $details */
    public function append(int $bookingId, string $type, string $actor, array $details = []): void
    {
        if (!\in_array($type, ['created', 'moved', 'cancelled', 'customer_updated'], true)) {
            throw new BookingValidationException('historyType', 'Unknown booking history event.');
        }
        if (!\in_array($actor, ['public', 'admin'], true)) {
            throw new BookingValidationException('historyActor', 'Unknown booking history actor.');
        }

        $json = json_encode($details, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            throw new BookingValidationException('historyDetails', 'History details are not JSON encodable.');
        }

        $this->database->run(
            'INSERT INTO booking_history (booking_id, event_type, actor_type, details_json, occurred_at)'
            . ' VALUES (:booking, :event, :actor, :details, :occurred)',
            [
                'booking' => $bookingId,
                'event' => $type,
                'actor' => $actor,
                'details' => $json,
                'occurred' => $this->clock->nowIso(),
            ],
        );
    }

    /** @return list<BookingHistoryEvent> */
    public function forBooking(int $bookingId): array
    {
        return array_map(static function (array $row): BookingHistoryEvent {
            $id = $row['id'] ?? null;
            $storedBookingId = $row['booking_id'] ?? null;
            $type = $row['event_type'] ?? null;
            $actor = $row['actor_type'] ?? null;
            $detailsJson = $row['details_json'] ?? null;
            $occurred = $row['occurred_at'] ?? null;
            if (
                !\is_int($id) || !\is_int($storedBookingId) || !\is_string($type)
                || !\is_string($actor) || !\is_string($detailsJson) || !\is_string($occurred)
            ) {
                throw new \RuntimeException('Booking history row is malformed.');
            }
            /** @var mixed $details */
            $details = json_decode($detailsJson, true);
            if (!\is_array($details)) {
                throw new \RuntimeException('Booking history details are malformed.');
            }

            $resolvedDetails = [];
            foreach ($details as $key => $value) {
                if (!\is_string($key)) {
                    throw new \RuntimeException('Booking history details are not an object.');
                }
                $resolvedDetails[$key] = $value;
            }

            return new BookingHistoryEvent($id, $storedBookingId, $type, $actor, $resolvedDetails, $occurred);
        }, $this->database->fetchAll(
            'SELECT id, booking_id, event_type, actor_type, details_json, occurred_at'
            . ' FROM booking_history WHERE booking_id = :booking ORDER BY id',
            ['booking' => $bookingId],
        ));
    }
}
