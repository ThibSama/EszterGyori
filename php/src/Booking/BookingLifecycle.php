<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Notification\BookingNotificationProducer;
use Eszter\Retention\BookingRetentionService;
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
 *
 * ESZ-164 adds the three GDPR booking writes — a rectification through the
 * same customer-update authority as the calendar's contact edit
 * ({@see updateCustomerContact()}), early anonymisation through the ESZ-140
 * erasure primitive ({@see anonymize()}) and the reversible restriction of
 * processing ({@see restrictProcessing()}, {@see liftProcessingRestriction()}).
 * Each is one booking write with its history event and, for a lift, its
 * notification, in the caller's transaction; the request centre wraps them
 * with the register's closure.
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
        /**
         * ESZ-164 — the erasure primitive the GDPR anonymisation runs. Null
         * only for a caller that never anonymises.
         */
        private readonly ?BookingRetentionService $retention = null,
    ) {
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function create(array $request): array
    {
        $serviceKeys = BookingRequestFields::serviceKeys($request);
        $requestedStart = BookingRequestFields::timestamp($request, 'startsAtUtc');
        $name = BookingRequestFields::requiredString($request, 'customerName');
        $email = BookingRequestFields::requiredString($request, 'customerEmail');
        $phone = BookingRequestFields::nullableString($request, 'customerPhone');
        $note = BookingRequestFields::nullableString($request, 'customerNote');
        // ESZ-161: a booking rests on the requested service, not on consent.
        // The domain refuses the pre-ESZ-161 consent fields outright — the
        // strict wire schema already does, and a direct caller must not be
        // able to make a new booking look like a consent one.
        foreach (['consentAccepted', 'consentNoticeId'] as $consentField) {
            if (\array_key_exists($consentField, $request)) {
                throw new BookingValidationException($consentField, 'Booking no longer models consent.');
            }
        }
        $privacyNoticeId = BookingRequestFields::requiredString($request, 'privacyNoticeId');
        // ESZ-161: acceptance is membership of the immutable privacy-notice
        // catalog — the same artifact the wire enum was generated from. An id
        // the catalog does not contain (a historical consent notice id, or
        // client-supplied text, which no field carries) is refused here,
        // before the transaction opens.
        if (!$this->contract->acceptsPrivacyNoticeId($privacyNoticeId)) {
            throw new BookingValidationException('privacyNoticeId', 'Unknown booking privacy notice.');
        }
        $localDate = $requestedStart->setTimezone(new \DateTimeZone($this->contract->timezone))->format('Y-m-d');
        $this->availability->assertRange($localDate, $localDate);

        $booking = $this->database->transactional(function () use (
            $serviceKeys,
            $requestedStart,
            $localDate,
            $name,
            $email,
            $phone,
            $note,
            $privacyNoticeId,
        ): Booking {
            // ESZ-146 — the authoritative serialization boundary first (see
            // BookingSerializationLock for the single lock order).
            $this->serialization->acquire();
            // ESZ-150: the offer revalidated under the boundary is what gets
            // stored — its first member as service_key, its combination key
            // (or null) and the interval the validated duration produced.
            ['offer' => $offer, 'slot' => $slot] = $this->availability->requestedSlot(
                $serviceKeys,
                $localDate,
                $requestedStart,
            );
            $booking = $this->bookings->createConfirmed(
                $offer->serviceKey,
                $slot->startsAtUtc,
                $slot->endsAtUtc,
                $name,
                $email,
                $phone,
                $note,
                // ESZ-161: the notice was presented for this very request;
                // its presentation instant is the creation instant.
                $this->clock->now(),
                $privacyNoticeId,
                $offer->combinationKey,
                // ESZ-153: the buffers of this very offer become the
                // booking's own snapshot.
                $offer,
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
        return $this->updateCustomerContact(
            $reference,
            BookingRequestFields::expectedUpdatedAt($request),
            BookingRequestFields::requiredString($request, 'customerName'),
            BookingRequestFields::requiredString($request, 'customerEmail'),
            BookingRequestFields::nullableString($request, 'customerPhone'),
            BookingRequestFields::nullableString($request, 'customerNote'),
        );
    }

    /**
     * The customer-update authority: the calendar's contact edit and a GDPR
     * rectification (ESZ-164) are this one method. The row lock, the
     * byte-for-byte token comparison, the repository's validation and
     * erasure guard and the `customer_updated` event are therefore single
     * source; there is no second customer UPDATE path.
     *
     * @param array<string, mixed> $historyDetails Extra non-personal facts for
     *     the history event (a rectification records the register's request
     *     id). Never a customer value.
     */
    public function updateCustomerContact(
        string $reference,
        string $expectedUpdatedAt,
        string $name,
        string $email,
        ?string $phone,
        ?string $note,
        array $historyDetails = [],
    ): Booking {
        return $this->database->transactional(function () use (
            $reference,
            $expectedUpdatedAt,
            $name,
            $email,
            $phone,
            $note,
            $historyDetails,
        ): Booking {
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            // ESZ-139: the caller's token must equal the current row before
            // anything is written; a stale editor is refused with 409
            // REVISION_CONFLICT and leaves row, history and jobs untouched.
            $this->assertNotStale($expectedUpdatedAt, $booking);
            $updated = $this->bookings->updateCustomer($booking, $name, $email, $phone, $note);
            if (
                $booking->customerName !== $updated->customerName
                || $booking->customerEmail !== $updated->customerEmail
                || $booking->customerPhone !== $updated->customerPhone
                || $booking->customerNote !== $updated->customerNote
            ) {
                $this->history->append($booking->id, 'customer_updated', 'admin', [
                    'fields' => self::changedCustomerFields($booking, $updated),
                ] + $historyDetails);
            }

            return $updated;
        });
    }

    /**
     * ESZ-164 — anonymises one booking now, through the ESZ-140 erasure
     * primitive, and records the fact in the trail.
     *
     * Future or past, confirmed or cancelled: the primitive re-reads the row
     * under its lock and erases it only if its data is still live, retiring
     * every pending or processing notification job in the same transaction.
     * Returns the booking as it now stands and whether this call erased it —
     * false when it was already anonymised, which is left exactly as it was,
     * with no second history event. No customer value is ever written to the
     * event: the details name the request, nothing else.
     *
     * @return array{booking: Booking, erased: bool, retired: int}
     */
    public function anonymize(string $reference, int $privacyRequestId): array
    {
        if ($this->retention === null) {
            throw new \LogicException('The booking lifecycle was built without the erasure primitive.');
        }

        return $this->database->transactional(function () use ($reference, $privacyRequestId): array {
            $booking = $this->bookings->find($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            $outcome = $this->retention->eraseBooking($booking->id);
            if ($outcome['erased']) {
                $this->history->append($booking->id, 'customer_data_erased', 'admin', [
                    'privacyRequestId' => $privacyRequestId,
                    'retiredJobs' => $outcome['retired'],
                ]);
            }
            $stored = $this->bookings->find($reference);
            if ($stored === null) {
                throw new \RuntimeException('The booking disappeared during its anonymisation.');
            }

            return ['booking' => $stored, 'erased' => $outcome['erased'], 'retired' => $outcome['retired']];
        });
    }

    /**
     * ESZ-164 — sets the restriction of processing on one booking.
     *
     * Under the row lock, so it serialises with the runner's claim of the
     * booking's jobs (the claim re-checks the marker before the transport).
     * An anonymised booking is refused by the repository; a booking already
     * restricted is returned unchanged with no second event.
     *
     * @return array{booking: Booking, changed: bool}
     */
    public function restrictProcessing(string $reference, int $privacyRequestId): array
    {
        return $this->database->transactional(function () use ($reference, $privacyRequestId): array {
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            if ($booking->processingRestrictedAt !== null) {
                return ['booking' => $booking, 'changed' => false];
            }
            $restricted = $this->bookings->setProcessingRestriction($booking, true);
            $this->history->append($booking->id, 'processing_restricted', 'admin', [
                'privacyRequestId' => $privacyRequestId,
            ]);

            return ['booking' => $restricted, 'changed' => true];
        });
    }

    /**
     * ESZ-164 — lifts the restriction on one booking and, in the same
     * transaction, schedules the one informational e-mail the lift sends.
     *
     * Nothing is replayed: the reminders the restriction held are still
     * pending rows and simply become claimable again; the stale sweep and the
     * claim-time window check decide, as they always do, which of them is
     * still worth sending. A booking that is not restricted (or has been
     * anonymised in the meantime, which cleared the marker) is returned
     * unchanged, with no event and no e-mail.
     *
     * @return array{booking: Booking, changed: bool}
     */
    public function liftProcessingRestriction(string $reference, int $privacyRequestId): array
    {
        return $this->database->transactional(function () use ($reference, $privacyRequestId): array {
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            if ($booking->processingRestrictedAt === null || $booking->customerDataErasedAt !== null) {
                return ['booking' => $booking, 'changed' => false];
            }
            $lifted = $this->bookings->setProcessingRestriction($booking, false);
            $liftedEventId = $this->history->append($booking->id, 'processing_restriction_lifted', 'admin', [
                'privacyRequestId' => $privacyRequestId,
            ]);
            $this->notifications->restrictionLifted($lifted, $liftedEventId);

            return ['booking' => $lifted, 'changed' => true];
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
            // ESZ-150/153: a move keeps the booking's stored services, its
            // stored duration and its buffer snapshot; only the start moves,
            // and the end follows by exactly the stored duration.
            $slot = $this->availability->requestedMoveSlot($booking, $localDate, $requestedStart);
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
