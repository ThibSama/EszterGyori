<?php

declare(strict_types=1);

namespace Eszter\Privacy;

use Eszter\Booking\BookingRequestFields;
use Eszter\Support\IsoTimestamp;

/**
 * One record of the GDPR request register (ESZ-163) — and the whole of it.
 *
 * There is no property for a requester's e-mail, message or identity
 * document, and none for a booking's customer data: the register names
 * bookings by reference only. What this object holds is exactly what the
 * wire exposes.
 */
final class PrivacyRequest
{
    /** @param list<string> $bookingReferences */
    public function __construct(
        public readonly int $id,
        public readonly string $type,
        public readonly string $status,
        public readonly string $receivedDate,
        public readonly string $deadlineDate,
        /** Database form (`Y-m-d H:i:s.v`) or null while the record is open. */
        public readonly ?string $closedAtUtc,
        public readonly array $bookingReferences,
        public readonly string $createdAt,
        public readonly string $updatedAt,
    ) {
    }

    /**
     * @param array<string, mixed> $row
     * @param list<string> $bookingReferences
     */
    public static function fromRow(array $row, array $bookingReferences): self
    {
        $id = $row['id'] ?? null;
        $type = $row['request_type'] ?? null;
        $status = $row['status'] ?? null;
        $received = $row['received_date'] ?? null;
        $deadline = $row['deadline_date'] ?? null;
        $closed = $row['closed_at_utc'] ?? null;
        $created = $row['created_at'] ?? null;
        $updated = $row['updated_at'] ?? null;

        if (
            !\is_int($id)
            || !\is_string($type)
            || !\is_string($status)
            || !\is_string($received)
            || !\is_string($deadline)
            || ($closed !== null && !\is_string($closed))
            || !\is_string($created)
            || !\is_string($updated)
        ) {
            throw new \RuntimeException('privacy_requests row is malformed.');
        }

        return new self($id, $type, $status, $received, $deadline, $closed, $bookingReferences, $created, $updated);
    }

    /** @return array<string, mixed> */
    public function payload(): array
    {
        return [
            'id' => $this->id,
            'type' => $this->type,
            'status' => $this->status,
            'receivedDate' => $this->receivedDate,
            'deadlineDate' => $this->deadlineDate,
            'closedAtUtc' => $this->closedAtUtc === null
                ? null
                : IsoTimestamp::format(BookingRequestFields::databaseInstant($this->closedAtUtc)),
            'bookingReferences' => $this->bookingReferences,
            'createdAt' => $this->createdAt,
            'updatedAt' => $this->updatedAt,
        ];
    }
}
