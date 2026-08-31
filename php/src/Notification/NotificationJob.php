<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * One stored notification job, as the runner sees it.
 *
 * Read-only and deliberately narrow: it carries the scheduling facts and the
 * booking's opaque reference, and no customer data at all. A transport that
 * needs an address asks the booking repository for it at delivery time, which
 * keeps the address out of the queue, out of the runner's memory for the whole
 * batch, and out of anything the runner logs.
 */
final class NotificationJob
{
    public function __construct(
        public readonly int $id,
        public readonly string $idempotencyKey,
        public readonly int $bookingId,
        public readonly string $bookingReference,
        public readonly string $channel,
        public readonly string $jobType,
        public readonly string $dueAtUtc,
        public readonly string $nextAttemptAtUtc,
        public readonly string $status,
        public readonly int $attempts,
        public readonly ?string $lastErrorCode,
        public readonly ?string $sentAtUtc,
        public readonly ?string $leaseOwner,
        public readonly ?string $leaseExpiresAtUtc,
    ) {
    }

    /**
     * @param array<string, mixed> $row A row from `notification_jobs` joined to
     *                                  `bookings.reference`.
     */
    public static function fromRow(array $row): self
    {
        return new self(
            self::integer($row, 'id'),
            self::text($row, 'idempotency_key'),
            self::integer($row, 'booking_id'),
            self::text($row, 'reference'),
            self::text($row, 'channel'),
            self::text($row, 'job_type'),
            self::text($row, 'due_at_utc'),
            self::text($row, 'next_attempt_at_utc'),
            self::text($row, 'status'),
            self::integer($row, 'attempts'),
            self::optionalText($row, 'last_error_code'),
            self::optionalText($row, 'sent_at_utc'),
            self::optionalText($row, 'lease_owner'),
            self::optionalText($row, 'lease_expires_at_utc'),
        );
    }

    /** @param array<string, mixed> $row */
    private static function integer(array $row, string $column): int
    {
        $value = $row[$column] ?? null;

        if (!\is_int($value)) {
            throw new NotificationException("notification_jobs.{$column} is not an integer.");
        }

        return $value;
    }

    /** @param array<string, mixed> $row */
    private static function text(array $row, string $column): string
    {
        $value = $row[$column] ?? null;

        if (!\is_string($value) || $value === '') {
            throw new NotificationException("notification_jobs.{$column} is not a non-empty string.");
        }

        return $value;
    }

    /** @param array<string, mixed> $row */
    private static function optionalText(array $row, string $column): ?string
    {
        $value = $row[$column] ?? null;

        if ($value === null) {
            return null;
        }

        if (!\is_string($value) || $value === '') {
            throw new NotificationException("notification_jobs.{$column} is not a nullable string.");
        }

        return $value;
    }
}
