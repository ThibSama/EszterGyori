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
        /**
         * ESZ-150 — the canonical key of the validated combination this
         * booking was made for, or null for a single-service booking (every
         * booking that predates ESZ-150 included; none is ever attributed
         * one). When set, `serviceKey` is the combination's first member.
         */
        public readonly ?string $combinationKey,
        public readonly BookingState $state,
        public readonly string $startsAtUtc,
        public readonly string $endsAtUtc,
        public readonly string $timezoneName,
        public readonly string $customerName,
        public readonly string $customerEmail,
        public readonly ?string $customerPhone,
        public readonly ?string $customerNote,
        /**
         * ESZ-142/ESZ-161 — the consent instant of a booking made under the
         * consent framing. Null for every booking created since ESZ-161: a
         * booking rests on the requested service, not on consent, and no
         * instant is ever fabricated for it.
         */
        public readonly ?string $consentAtUtc,
        /**
         * ESZ-142 — the machine id of the immutable consent-notice catalog
         * entry whose text this booking's visitor accepted. Null means the
         * booking predates the catalog (it carries a consent instant but no
         * notice id) or was created since ESZ-161; nothing ever invents one.
         */
        public readonly ?string $consentNoticeId,
        /**
         * ESZ-161 — the machine id of the immutable privacy-notice catalog
         * entry the form displayed to this booking's customer, and the
         * instant it was presented. Both null for a booking that predates
         * ESZ-161; both set for every booking created since.
         */
        public readonly ?string $privacyNoticeId,
        public readonly ?string $privacyNoticePresentedAtUtc,
        public readonly ?string $cancelledAtUtc,
        public readonly ?string $cancellationReason,
        /**
         * ESZ-140: when customer-data retention anonymized this booking. Null
         * means the customer data is live; once set, the row accepts no
         * further customer or lifecycle write.
         */
        public readonly ?string $customerDataErasedAt,
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
            self::nullableString($row, 'combination_key'),
            BookingState::fromString(self::requiredString($row, 'state'), $contract),
            self::requiredString($row, 'starts_at_utc'),
            self::requiredString($row, 'ends_at_utc'),
            self::requiredString($row, 'timezone_name'),
            self::requiredString($row, 'customer_name'),
            self::requiredString($row, 'customer_email'),
            self::nullableString($row, 'customer_phone'),
            self::nullableString($row, 'customer_note'),
            self::nullableString($row, 'consent_at_utc'),
            self::nullableString($row, 'consent_notice_id'),
            self::nullableString($row, 'privacy_notice_id'),
            self::nullableString($row, 'privacy_notice_presented_at_utc'),
            self::nullableString($row, 'cancelled_at_utc'),
            self::nullableString($row, 'cancellation_reason'),
            self::nullableString($row, 'customer_data_erased_at'),
            self::requiredString($row, 'created_at'),
            self::requiredString($row, 'updated_at'),
            self::requiredString($row, 'state_changed_at'),
        );
    }

    /**
     * ESZ-150 — every service this booking is for, canonical order: the
     * combination's members, or the single stored key.
     *
     * @return list<string>
     */
    public function serviceKeys(): array
    {
        return $this->combinationKey === null
            ? [$this->serviceKey]
            : ServiceCombination::membersOf($this->combinationKey);
    }

    /**
     * ESZ-153 — the stored duration, in whole minutes: the authoritative
     * duration snapshot is the row's own `starts_at_utc` → `ends_at_utc`,
     * which creation fixed to the revalidated offer's duration and a move
     * carries over unchanged. No separate duration column exists to disagree
     * with it.
     */
    public function durationMinutes(): int
    {
        $seconds = BookingRequestFields::databaseInstant($this->endsAtUtc)->getTimestamp()
            - BookingRequestFields::databaseInstant($this->startsAtUtc)->getTimestamp();
        if ($seconds <= 0 || $seconds % 60 !== 0) {
            throw new \RuntimeException('The stored booking interval is not a whole positive number of minutes.');
        }

        return intdiv($seconds, 60);
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
