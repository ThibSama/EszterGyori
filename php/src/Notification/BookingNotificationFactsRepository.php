<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Database\Database;

/** Resolves the current customer-facing booking facts at delivery time. */
final class BookingNotificationFactsRepository implements BookingNotificationFactsProvider
{
    public function __construct(private readonly Database $database)
    {
    }

    public function forJob(NotificationJob $job): BookingNotificationFacts
    {
        $row = $this->database->fetchOne(
            'SELECT b.customer_email, b.starts_at_utc, b.reference, s.booking_label'
            . ' FROM bookings b JOIN booking_services s ON s.service_key = b.service_key'
            . ' WHERE b.id = :booking',
            ['booking' => $job->bookingId],
        );
        if ($row === null) {
            throw new PermanentDeliveryException('booking_unavailable');
        }

        $email = $row['customer_email'] ?? null;
        $start = $row['starts_at_utc'] ?? null;
        $reference = $row['reference'] ?? null;
        $label = $row['booking_label'] ?? null;
        if (
            !\is_string($email) || filter_var($email, FILTER_VALIDATE_EMAIL) === false
            || !\is_string($start) || !\is_string($reference) || !\is_string($label)
            || $reference !== $job->bookingReference
        ) {
            throw new PermanentDeliveryException('booking_unavailable');
        }

        $startsAt = \DateTimeImmutable::createFromFormat(
            '!Y-m-d H:i:s.v',
            $start,
            new \DateTimeZone('UTC'),
        );
        if (!$startsAt instanceof \DateTimeImmutable) {
            throw new PermanentDeliveryException('booking_unavailable');
        }

        return new BookingNotificationFacts($email, $label, $startsAt, $reference, $job->jobType);
    }
}
