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

    /**
     * Appends one immutable event and returns its row id.
     *
     * The returned id is the event's stable position in the append-only trail.
     * ESZ-131 uses it as the lifecycle identity of the notification jobs the
     * same transaction schedules: the runner re-checks a claimed job against
     * later events by comparing ids, so the ordering never depends on
     * timestamps.
     *
     * @param array<string, mixed> $details
     */
    public function append(int $bookingId, string $type, string $actor, array $details = []): int
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

        return (int) $this->database->pdo()->lastInsertId();
    }

    /**
     * ESZ-145 — one fixed page of a booking's history, oldest first.
     *
     * The continuation is the monotonic history row id: rows are served in
     * ascending id order and the caller asks for the events strictly after
     * `$afterId`, so paging can neither duplicate nor skip an event and a
     * replayed cursor cannot loop. The query fetches `$pageSize + 1` rows so
     * `hasMore` is decided from the surplus row: a page is never silently
     * clipped to a smaller answer than the trail holds. The page size is not
     * a caller-chosen bound — the API passes the domain's own fixed size —
     * but a non-positive value is still refused here rather than trusted.
     *
     * @return array{events: list<BookingHistoryEvent>, hasMore: bool}
     */
    public function pageForBooking(int $bookingId, int $pageSize, ?int $afterId = null): array
    {
        if ($pageSize < 1) {
            throw new BookingValidationException('historyPageSize', 'History page size must be positive.');
        }
        if ($afterId !== null && $afterId < 1) {
            throw new BookingValidationException('historyCursor', 'History cursor is malformed.');
        }

        $parameters = ['booking' => $bookingId];
        $after = '';
        if ($afterId !== null) {
            $after = ' AND id > :after_id';
            $parameters['after_id'] = $afterId;
        }

        $rows = $this->database->fetchAll(
            'SELECT id, booking_id, event_type, actor_type, details_json, occurred_at'
            . ' FROM booking_history WHERE booking_id = :booking' . $after
            . ' ORDER BY id LIMIT ' . ($pageSize + 1),
            $parameters,
        );

        $hasMore = \count($rows) > $pageSize;

        $events = array_map(static function (array $row): BookingHistoryEvent {
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
        }, \array_slice($rows, 0, $pageSize));

        return ['events' => $events, 'hasMore' => $hasMore];
    }
}
