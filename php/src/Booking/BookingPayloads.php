<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Support\IsoTimestamp;

/**
 * The booking wire payloads (ESZ-106).
 *
 * One authority for how a {@see Booking} becomes the frozen public and admin
 * response shapes, shared by the command orchestration (create responses and
 * admin mutation responses echo the current facts) and the admin reader
 * (range rows and the reference read use the same current-state shape).
 */
final class BookingPayloads
{
    /** @return array<string, mixed> */
    public static function publicBookingPayload(Booking $booking): array
    {
        return [
            'reference' => $booking->reference,
            'serviceKey' => $booking->serviceKey,
            'state' => $booking->state->value,
            'startsAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->startsAtUtc)),
            'endsAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->endsAtUtc)),
        ];
    }

    /**
     * ESZ-145 — current-state booking facts only.
     *
     * Deliberately no `history` array and no history read: a range page of
     * many bookings and every mutation response pay for exactly zero history
     * SQL per booking. History is served only by the reference read, as its
     * own bounded page.
     *
     * @return array<string, mixed>
     */
    public static function adminBookingPayload(Booking $booking): array
    {
        return [
            ...self::publicBookingPayload($booking),
            'timezone' => $booking->timezoneName,
            'customerName' => $booking->customerName,
            'customerEmail' => $booking->customerEmail,
            'customerPhone' => $booking->customerPhone,
            'customerNote' => $booking->customerNote,
            'consentAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->consentAtUtc)),
            'cancelledAtUtc' => $booking->cancelledAtUtc === null
                ? null
                : IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->cancelledAtUtc)),
            'cancellationReason' => $booking->cancellationReason,
            'createdAt' => $booking->createdAt,
            'updatedAt' => $booking->updatedAt,
        ];
    }
}
