<?php

declare(strict_types=1);

namespace Eszter\Privacy;

use Eszter\Booking\Booking;
use Eszter\Booking\BookingLifecycle;
use Eszter\Booking\BookingNotFoundException;
use Eszter\Booking\BookingRepository;
use Eszter\Booking\BookingRequestFields;
use Eszter\Booking\BookingValidationException;
use Eszter\Database\Database;
use Eszter\Support\IsoTimestamp;

/**
 * The execution of the five V1 rights from a recorded request (ESZ-164).
 *
 * ## Only the request's links
 *
 * Every action starts from the register record and acts on the bookings its
 * stored references name — resolved here, in stored order — and on nothing
 * else. A rectification entry naming a reference the request does not hold
 * is refused before any write; no action accepts a booking reference of its
 * own. A reference that has been anonymised since the request was recorded
 * is shown as anonymised and is never rectified, restricted, notified or
 * reconnected to its former identity.
 *
 * ## Where the writes happen
 *
 * This class writes no booking column itself. Rectification, anonymisation,
 * restriction and lift are {@see BookingLifecycle}'s — the same authority,
 * locks, validation, history and notification scheduling as every other
 * booking write — and this class wraps them in one transaction with the
 * register's transition, so a failed action leaves both the bookings and
 * the record as they were.
 *
 * ## What the register receives
 *
 * A status transition. The export body, the rectified values and every
 * other customer fact stay in the response and in the booking rows; the
 * register holds references and instants only, as ESZ-163 froze it.
 */
final class PrivacyRightsExecution
{
    private const EXPORT_TYPES = ['access', 'portability'];

    public function __construct(
        private readonly Database $database,
        private readonly PrivacyRequestPolicy $policy,
        private readonly PrivacyRequestRepository $requests,
        private readonly BookingRepository $bookings,
        private readonly BookingLifecycle $lifecycle,
        private readonly PrivacyDataExport $export,
    ) {
    }

    /**
     * `mode=scope`: the record beside the current state of each booking it
     * names, what the action forms are built from.
     *
     * @return array<string, mixed>
     */
    public function scope(int $id): array
    {
        $record = $this->requests->find($id) ?? throw new PrivacyRequestNotFoundException($id);

        return $this->outcome($record, $this->linkedBookings($record), null);
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function execute(array $request): array
    {
        $action = BookingRequestFields::requiredString($request, 'action');
        $id = BookingRequestFields::requiredInt($request, 'id');

        return match ($action) {
            'export' => $this->export($id, BookingRequestFields::requiredString($request, 'format')),
            'rectify' => $this->rectify($id, $request['bookings'] ?? null),
            'anonymize' => $this->anonymize($id, $request),
            'restrict' => $this->restrict($id),
            'lift' => $this->lift($id, $request),
            default => throw new BookingValidationException('action', 'Unknown privacy request action.'),
        };
    }

    /** @return array<string, mixed> */
    private function export(int $id, string $format): array
    {
        if (!\in_array($format, ['html', 'json'], true)) {
            throw new BookingValidationException('format', 'Unknown export format.');
        }
        $record = $this->requests->find($id) ?? throw new PrivacyRequestNotFoundException($id);
        if (!\in_array($record->type, self::EXPORT_TYPES, true)) {
            throw new BookingValidationException(
                'type',
                'Only an access or portability request is answered by an export.',
            );
        }

        $bookings = $this->linkedBookings($record);
        $document = $this->export->document($record, $bookings);
        // The document is built; the register records that the right was
        // executed. A closed request may be exported again — the second
        // export changes nothing.
        $record = $this->database->transactional(fn (): PrivacyRequest => $this->close($record));

        return $this->outcome($record, $bookings, [
            'format' => $format,
            'fileName' => $this->export->fileName($record, $format),
            'document' => $format === 'html' ? $this->export->html($document) : $document,
        ]);
    }

    /**
     * @param mixed $entries
     * @return array<string, mixed>
     */
    private function rectify(int $id, mixed $entries): array
    {
        $record = $this->openRecordOfType($id, 'rectification');
        if (!\is_array($entries) || !array_is_list($entries) || $entries === []) {
            throw new BookingValidationException('bookings', 'A rectification names at least one booking.');
        }

        $updates = [];
        foreach ($entries as $entry) {
            if (!\is_array($entry)) {
                throw new BookingValidationException('bookings', 'A rectification entry is malformed.');
            }
            /** @var array<string, mixed> $entry */
            $reference = BookingRequestFields::requiredString($entry, 'reference');
            // The scope guarantee: only the request's own links, each once.
            if (!\in_array($reference, $record->bookingReferences, true)) {
                throw new BookingValidationException('reference', 'The request does not name this booking.');
            }
            if (isset($updates[$reference])) {
                throw new BookingValidationException('reference', 'A booking is rectified twice.');
            }
            $updates[$reference] = [
                'expectedUpdatedAt' => BookingRequestFields::expectedUpdatedAt($entry),
                'name' => BookingRequestFields::requiredString($entry, 'customerName'),
                'email' => BookingRequestFields::requiredString($entry, 'customerEmail'),
                'phone' => BookingRequestFields::nullableString($entry, 'customerPhone'),
                'note' => BookingRequestFields::nullableString($entry, 'customerNote'),
            ];
        }

        $closed = $this->database->transactional(function () use ($record, $updates): PrivacyRequest {
            foreach ($updates as $reference => $update) {
                $booking = $this->bookings->find($reference) ?? throw new BookingNotFoundException($reference);
                if ($booking->customerDataErasedAt !== null) {
                    throw new BookingValidationException(
                        'reference',
                        'An anonymised booking has no customer data left to rectify.',
                    );
                }
                $this->lifecycle->updateCustomerContact(
                    $reference,
                    $update['expectedUpdatedAt'],
                    $update['name'],
                    $update['email'],
                    $update['phone'],
                    $update['note'],
                    ['privacyRequestId' => $record->id],
                );
            }

            return $this->close($record);
        });

        return $this->outcome($closed, $this->linkedBookings($closed), null);
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    private function anonymize(int $id, array $request): array
    {
        self::assertConfirmed($request);
        $record = $this->openRecordOfType($id, 'erasure');
        $live = array_filter(
            $this->linkedBookings($record),
            static fn (Booking $booking): bool => $booking->customerDataErasedAt === null,
        );
        if ($live === []) {
            throw new BookingValidationException(
                'bookingReferences',
                'The request names no booking whose customer data is still live.',
            );
        }

        $closed = $this->database->transactional(function () use ($record, $live): PrivacyRequest {
            foreach ($live as $booking) {
                $this->lifecycle->anonymize($booking->reference, $record->id);
            }

            return $this->close($record);
        });

        return $this->outcome($closed, $this->linkedBookings($closed), null);
    }

    /** @return array<string, mixed> */
    private function restrict(int $id): array
    {
        $record = $this->openRecordOfType($id, 'restriction');
        $live = array_filter(
            $this->linkedBookings($record),
            static fn (Booking $booking): bool => $booking->customerDataErasedAt === null,
        );
        if ($live === []) {
            throw new BookingValidationException(
                'bookingReferences',
                'The request names no booking whose processing can be restricted.',
            );
        }

        $closed = $this->database->transactional(function () use ($record, $live): PrivacyRequest {
            foreach ($live as $booking) {
                $this->lifecycle->restrictProcessing($booking->reference, $record->id);
            }

            return $this->close($record);
        });

        return $this->outcome($closed, $this->linkedBookings($closed), null);
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    private function lift(int $id, array $request): array
    {
        self::assertConfirmed($request);
        $record = $this->requests->find($id) ?? throw new PrivacyRequestNotFoundException($id);
        if ($record->type !== 'restriction') {
            throw new BookingValidationException('type', 'Only a restriction request can be lifted.');
        }
        $restricted = array_filter(
            $this->linkedBookings($record),
            static fn (Booking $booking): bool => $booking->processingRestrictedAt !== null
                && $booking->customerDataErasedAt === null,
        );
        if ($restricted === []) {
            throw new BookingValidationException(
                'bookingReferences',
                'The request names no booking whose processing is restricted.',
            );
        }

        // The lift changes the bookings, not the record: the request was
        // executed when the restriction was set, and stays closed.
        $this->database->transactional(function () use ($record, $restricted): void {
            foreach ($restricted as $booking) {
                $this->lifecycle->liftProcessingRestriction($booking->reference, $record->id);
            }
        });

        return $this->outcome($record, $this->linkedBookings($record), null);
    }

    /** A record of the given type that has not been closed yet. */
    private function openRecordOfType(int $id, string $type): PrivacyRequest
    {
        $record = $this->requests->find($id) ?? throw new PrivacyRequestNotFoundException($id);
        if ($record->type !== $type) {
            throw new BookingValidationException('type', "This action answers a {$type} request only.");
        }
        if ($record->status === 'closed') {
            throw new BookingValidationException('status', 'This request is already closed.');
        }

        return $record;
    }

    /**
     * received → in_progress → closed, or the remaining part of it, under
     * the repository's conditional transitions: a concurrent second
     * execution finds the row already moved and is refused rather than
     * applied twice.
     */
    private function close(PrivacyRequest $record): PrivacyRequest
    {
        if ($record->status === 'closed') {
            return $record;
        }
        if ($record->status === $this->policy->initialStatus) {
            $record = $this->requests->startExecution($record->id);
        }

        return $this->requests->close($record->id);
    }

    /**
     * The request's linked bookings, in stored order. A reference that
     * resolves to no booking (bookings are never deleted; a restore from an
     * older backup is the only way) is omitted rather than failing every
     * action on the record.
     *
     * @return list<Booking>
     */
    private function linkedBookings(PrivacyRequest $record): array
    {
        $bookings = [];
        foreach ($record->bookingReferences as $reference) {
            $booking = $this->bookings->find($reference);
            if ($booking !== null) {
                $bookings[] = $booking;
            }
        }

        return $bookings;
    }

    /**
     * @param list<Booking> $bookings
     * @param array<string, mixed>|null $export
     * @return array<string, mixed>
     */
    private function outcome(PrivacyRequest $record, array $bookings, ?array $export): array
    {
        return [
            'request' => $record->payload(),
            'bookings' => array_map(self::scopeEntry(...), $bookings),
            'export' => $export,
        ];
    }

    /** @return array<string, mixed> */
    private static function scopeEntry(Booking $booking): array
    {
        $erased = $booking->customerDataErasedAt !== null;

        return [
            'reference' => $booking->reference,
            'serviceKeys' => $booking->serviceKeys(),
            'state' => $booking->state->value,
            'startsAtUtc' => self::instant($booking->startsAtUtc),
            'endsAtUtc' => self::instant($booking->endsAtUtc),
            'updatedAt' => $booking->updatedAt,
            'customerDataErasedAt' => $erased ? self::instant((string) $booking->customerDataErasedAt) : null,
            'processingRestrictedAt' => $booking->processingRestrictedAt === null
                ? null
                : self::instant($booking->processingRestrictedAt),
            'customer' => $erased ? null : [
                'name' => $booking->customerName,
                'email' => $booking->customerEmail,
                'phone' => $booking->customerPhone,
                'note' => $booking->customerNote,
            ],
        ];
    }

    /** @param array<string, mixed> $request */
    private static function assertConfirmed(array $request): void
    {
        if (($request['confirm'] ?? null) !== true) {
            throw new BookingValidationException('confirm', 'This action requires an explicit confirmation.');
        }
    }

    private static function instant(string $databaseInstant): string
    {
        return IsoTimestamp::format(BookingRequestFields::databaseInstant($databaseInstant));
    }
}
