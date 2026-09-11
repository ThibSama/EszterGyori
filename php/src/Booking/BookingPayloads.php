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
            'serviceKeys' => $booking->serviceKeys(),
            'combinationKey' => $booking->combinationKey,
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
            // ESZ-161: the basis evidence, exposed as the nullable facts they
            // are — a consent instant for bookings made under ESZ-142, the
            // privacy notice and its presentation instant since.
            'consentAtUtc' => self::optionalInstant($booking->consentAtUtc),
            'privacyNoticeId' => $booking->privacyNoticeId,
            'privacyNoticePresentedAtUtc' => self::optionalInstant($booking->privacyNoticePresentedAtUtc),
            'cancelledAtUtc' => self::optionalInstant($booking->cancelledAtUtc),
            'cancellationReason' => $booking->cancellationReason,
            'createdAt' => $booking->createdAt,
            'updatedAt' => $booking->updatedAt,
        ];
    }

    private static function optionalInstant(?string $databaseInstant): ?string
    {
        return $databaseInstant === null
            ? null
            : IsoTimestamp::format(BookingRequestFields::databaseInstant($databaseInstant));
    }
}
