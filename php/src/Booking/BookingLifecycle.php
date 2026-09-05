<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Notification\BookingNotificationProducer;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * Booking lifecycle commands: public creation and the admin update/move/cancel
 * mutations (ESZ-106).
 *
 * The only class that orchestrates a booking write. Every command runs inside
 * one database transaction, takes the booking serialization boundary before
 * any booking-row lock (except a contact update, which takes only the row
 * lock by design), revalidates the slot against the current schedule and
 * appends history and notification scheduling inside the same transaction.
 * Stale `expectedUpdatedAt` tokens are refused here, before any write,
 * history or notification.
 */
final class BookingLifecycle
{
    public function __construct(
        private readonly Database $database,
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
        private readonly Clock $clock,
        private readonly BookingSerializationLock $serialization,
        private readonly SlotAvailability $availability,
        private readonly BookingRepository $bookings,
        private readonly BookingHistoryRepository $history,
        private readonly BookingNotificationProducer $notifications,
    ) {
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function create(array $request): array
    {
        $serviceKey = BookingRequestFields::requiredString($request, 'serviceKey');
        $requestedStart = BookingRequestFields::timestamp($request, 'startsAtUtc');
        $name = BookingRequestFields::requiredString($request, 'customerName');
        $email = BookingRequestFields::requiredString($request, 'customerEmail');
        $phone = BookingRequestFields::nullableString($request, 'customerPhone');
        $note = BookingRequestFields::nullableString($request, 'customerNote');
        $consentNoticeId = BookingRequestFields::requiredString($request, 'consentNoticeId');
        // ESZ-142: acceptance is membership of the immutable notice catalog —
        // the same artifact the wire enum was generated from. An id the
        // catalog does not contain (and no client-supplied text, which no
        // field carries) is refused here, before the transaction opens.
        if (!$this->contract->acceptsConsentNoticeId($consentNoticeId)) {
            throw new BookingValidationException('consentNoticeId', 'Unknown booking consent notice.');
        }
        if (($request['consentAccepted'] ?? null) !== true) {
            throw new BookingValidationException('consentAccepted', 'Booking consent must be explicit.');
        }
        $localDate = $requestedStart->setTimezone(new \DateTimeZone($this->contract->timezone))->format('Y-m-d');
        $this->availability->assertRange($localDate, $localDate);

        $booking = $this->database->transactional(function () use (
            $serviceKey,
            $requestedStart,
            $localDate,
            $name,
            $email,
            $phone,
            $note,
            $consentNoticeId,
        ): Booking {
            // ESZ-146 — the authoritative serialization boundary first (see
            // BookingSerializationLock for the single lock order).
            $this->serialization->acquire();
            $slot = $this->availability->requestedSlot($serviceKey, $localDate, $requestedStart);
            $booking = $this->bookings->createConfirmed(
                $serviceKey,
                $slot->startsAtUtc,
                $slot->endsAtUtc,
                $name,
                $email,
                $phone,
                $note,
                $this->clock->now(),
                $consentNoticeId,
            );
            // ESZ-131: the created event's row id is the lifecycle identity of
            // the confirmation job scheduled just below; the two share this
            // transaction, so the marker can never name a different occurrence.
            $createdEventId = $this->history->append($booking->id, 'created', 'public');
            $this->notifications->created($booking, $createdEventId);

            return $booking;
        });

        return BookingPayloads::publicBookingPayload($booking);
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutate(array $request): array
    {
        $action = BookingRequestFields::requiredString($request, 'action');
        $reference = BookingRequestFields::requiredString($request, 'reference');
        // ESZ-139: the canonical-UTC form is checked once here for every
        // action; the byte-for-byte comparison against the current row
        // happens under the authoritative row lock inside each mutation.
        $expectedUpdatedAt = BookingRequestFields::expectedUpdatedAt($request);

        $booking = match ($action) {
            'update' => $this->updateCustomer($reference, $request),
            'move' => $this->move(
                $reference,
                $expectedUpdatedAt,
                BookingRequestFields::timestamp($request, 'startsAtUtc'),
            ),
            'cancel' => $this->cancel(
                $reference,
                $expectedUpdatedAt,
                BookingRequestFields::nullableString($request, 'reason'),
            ),
            default => throw new BookingValidationException('action', 'Unknown booking action.'),
        };

        return ['booking' => BookingPayloads::adminBookingPayload($booking)];
    }

    /** @param array<string, mixed> $request */
    private function updateCustomer(string $reference, array $request): Booking
    {
        return $this->database->transactional(function () use ($reference, $request): Booking {
            $expectedUpdatedAt = BookingRequestFields::expectedUpdatedAt($request);
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            // ESZ-139: the caller's token must equal the current row before
            // anything is written; a stale editor is refused with 409
            // REVISION_CONFLICT and leaves row, history and jobs untouched.
            $this->assertNotStale($expectedUpdatedAt, $booking);
            $updated = $this->bookings->updateCustomer(
                $booking,
                BookingRequestFields::requiredString($request, 'customerName'),
                BookingRequestFields::requiredString($request, 'customerEmail'),
                BookingRequestFields::nullableString($request, 'customerPhone'),
                BookingRequestFields::nullableString($request, 'customerNote'),
            );
            if (
                $booking->customerName !== $updated->customerName
                || $booking->customerEmail !== $updated->customerEmail
                || $booking->customerPhone !== $updated->customerPhone
                || $booking->customerNote !== $updated->customerNote
            ) {
                $this->history->append($booking->id, 'customer_updated', 'admin', [
                    'fields' => self::changedCustomerFields($booking, $updated),
                ]);
            }

            return $updated;
        });
    }

    private function move(
        string $reference,
        string $expectedUpdatedAt,
        \DateTimeImmutable $requestedStart,
    ): Booking {
        $localDate = $requestedStart->setTimezone(new \DateTimeZone($this->contract->timezone))->format('Y-m-d');
        $this->availability->assertRange($localDate, $localDate);

        return $this->database->transactional(function () use (
            $reference,
            $expectedUpdatedAt,
            $requestedStart,
            $localDate,
        ): Booking {
            // ESZ-146 — the authoritative serialization boundary first (see
            // BookingSerializationLock for the single lock order).
            $this->serialization->acquire();
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            // ESZ-139: compared under both authoritative locks (boundary then
            // row) and before any write, history or notification.
            $this->assertNotStale($expectedUpdatedAt, $booking);
            if ($booking->state->value !== 'confirmed') {
                throw new InvalidBookingTransitionException($booking->state->value, 'moved');
            }
            if ($booking->startsAtUtc === $this->time->databaseUtc($requestedStart)) {
                throw new BookingValidationException('startsAtUtc', 'Booking already starts at that instant.');
            }
            $slot = $this->availability->requestedSlot(
                $booking->serviceKey,
                $localDate,
                $requestedStart,
                $reference,
            );
            $updated = $this->bookings->move($booking, $slot->startsAtUtc, $slot->endsAtUtc);
            // ESZ-131: the moved event's row id marks the booking_moved job, so
            // a later move or cancellation can prove it obsolete.
            $movedEventId = $this->history->append($booking->id, 'moved', 'admin', [
                'from' => IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->startsAtUtc)),
                'to' => IsoTimestamp::format($slot->startsAtUtc),
            ]);
            $this->notifications->moved($booking, $updated, $movedEventId);

            return $updated;
        });
    }

    private function cancel(
        string $reference,
        string $expectedUpdatedAt,
        ?string $reason,
    ): Booking {
        return $this->database->transactional(function () use ($reference, $expectedUpdatedAt, $reason): Booking {
            // ESZ-146 — the authoritative serialization boundary first (see
            // BookingSerializationLock for the single lock order).
            $this->serialization->acquire();
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            // ESZ-139: compared under both authoritative locks (boundary then
            // row) and before any write, history or notification.
            $this->assertNotStale($expectedUpdatedAt, $booking);
            $cancelled = $this->bookings->transition($reference, 'cancelled', $reason);
            // ESZ-131: the cancelled event's row id marks the cancellation job.
            $cancelledEventId = $this->history->append($booking->id, 'cancelled', 'admin');
            $this->notifications->cancelled($cancelled, $cancelledEventId);

            return $cancelled;
        });
    }

    /**
     * ESZ-139 — the V1 optimistic-concurrency refusal.
     *
     * The caller's token is compared byte-for-byte with the row read under the
     * authoritative lock. The comparison must precede every write, history
     * append and notification scheduling of the mutation.
     */
    private function assertNotStale(string $expectedUpdatedAt, Booking $booking): void
    {
        if ($expectedUpdatedAt !== $booking->updatedAt) {
            throw new BookingRevisionConflictException($expectedUpdatedAt, $booking->updatedAt);
        }
    }

    /** @return list<string> */
    private static function changedCustomerFields(Booking $before, Booking $after): array
    {
        $changed = [];
        foreach (
            [
                'customerName' => [$before->customerName, $after->customerName],
                'customerEmail' => [$before->customerEmail, $after->customerEmail],
                'customerPhone' => [$before->customerPhone, $after->customerPhone],
                'customerNote' => [$before->customerNote, $after->customerNote],
            ] as $field => [$old, $new]
        ) {
            if ($old !== $new) {
                $changed[] = $field;
            }
        }

        return $changed;
    }
}
