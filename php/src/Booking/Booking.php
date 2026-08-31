<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** Persisted appointment facts. State changes never erase this object or its row. */
final class Booking
{
    public function __construct(
        public readonly int $id,
        public readonly string $reference,
        public readonly string $serviceKey,
        public readonly BookingState $state,
        public readonly string $startsAtUtc,
        public readonly string $endsAtUtc,
        public readonly string $timezoneName,
        public readonly string $customerName,
        public readonly string $customerEmail,
        public readonly ?string $customerPhone,
        public readonly ?string $customerNote,
        public readonly string $consentAtUtc,
        public readonly ?string $cancelledAtUtc,
        public readonly ?string $cancellationReason,
        public readonly string $createdAt,
        public readonly string $updatedAt,
        public readonly string $stateChangedAt,
    ) {
    }

    /** @param array<string, mixed> $row */
    public static function fromRow(array $row, BookingDomainContract $contract): self
    {
        $id = $row['id'] ?? null;
        if (!\is_int($id)) {
            throw new \RuntimeException('bookings row has no integer id.');
        }

        return new self(
            $id,
            self::requiredString($row, 'reference'),
            self::requiredString($row, 'service_key'),
            BookingState::fromString(self::requiredString($row, 'state'), $contract),
            self::requiredString($row, 'starts_at_utc'),
            self::requiredString($row, 'ends_at_utc'),
            self::requiredString($row, 'timezone_name'),
            self::requiredString($row, 'customer_name'),
            self::requiredString($row, 'customer_email'),
            self::nullableString($row, 'customer_phone'),
            self::nullableString($row, 'customer_note'),
            self::requiredString($row, 'consent_at_utc'),
            self::nullableString($row, 'cancelled_at_utc'),
            self::nullableString($row, 'cancellation_reason'),
            self::requiredString($row, 'created_at'),
            self::requiredString($row, 'updated_at'),
            self::requiredString($row, 'state_changed_at'),
        );
    }

    /** @param array<string, mixed> $row */
    private static function requiredString(array $row, string $field): string
    {
        $value = $row[$field] ?? null;
        if (!\is_string($value)) {
            throw new \RuntimeException("bookings row has no string {$field}.");
        }

        return $value;
    }

    /** @param array<string, mixed> $row */
    private static function nullableString(array $row, string $field): ?string
    {
        $value = $row[$field] ?? null;
        if ($value !== null && !\is_string($value)) {
            throw new \RuntimeException("bookings row has a malformed {$field}.");
        }

        return $value;
    }
}
