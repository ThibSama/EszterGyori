<?php

declare(strict_types=1);

namespace Eszter\Privacy;

use Eszter\Booking\Booking;
use Eszter\Booking\BookingNotFoundException;
use Eszter\Booking\BookingRepository;
use Eszter\Booking\BookingRequestFields;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Support\IsoTimestamp;

/**
 * The admin GDPR request centre's use cases (ESZ-163).
 *
 * Three reads and one write, all behind the authenticated admin surface:
 *
 *  - {@see adminPrivacyRequestSearch()} resolves the requester's scope — one
 *    booking by reference (current or legacy shape) or one page of the live
 *    bookings a customer e-mail names;
 *  - {@see adminPrivacyRequests()} reads the register — one history page, or
 *    one record;
 *  - {@see adminRecordPrivacyRequest()} stores one reviewed request: the
 *    frozen type, the reception date and exactly the references the
 *    administrator selected.
 *
 * Recording is this module's final action. It changes no booking and no
 * customer row, exports nothing and sends nothing: executing the right is
 * ESZ-164's, through the repository's lifecycle transitions.
 */
final class PrivacyRequestAdministration
{
    public function __construct(
        private readonly PrivacyRequestPolicy $policy,
        private readonly PrivacyRequestRepository $requests,
        private readonly BookingRepository $bookings,
        private readonly BookingTimePolicy $time,
    ) {
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminPrivacyRequestSearch(array $request): array
    {
        $mode = BookingRequestFields::requiredString($request, 'mode');

        if ($mode === 'reference') {
            $reference = BookingRequestFields::requiredString($request, 'reference');
            $booking = $this->bookings->find($reference);
            // An erased booking has no customer left to identify: it is not
            // a match, for the same reason the e-mail read excludes it.
            if ($booking === null || $booking->customerDataErasedAt !== null) {
                throw new BookingNotFoundException($reference);
            }

            return [
                'matches' => [self::match($booking)],
                'page' => $this->searchPageMeta(false, null),
            ];
        }

        if ($mode === 'email') {
            $email = BookingRequestFields::requiredString($request, 'email');
            $cursor = $request['cursor'] ?? null;
            $anchorStart = null;
            $anchorReference = null;
            if ($cursor !== null) {
                if (!\is_array($cursor)) {
                    throw new BookingValidationException('cursor', 'Search cursor is malformed.');
                }
                /** @var array<string, mixed> $cursor */
                $anchorStart = $this->time->databaseUtc(BookingRequestFields::timestamp($cursor, 'startsAtUtc'));
                $anchorReference = BookingRequestFields::requiredString($cursor, 'reference');
            }

            $page = $this->bookings->pageLiveByEmail(
                $email,
                $anchorStart,
                $anchorReference,
                $this->policy->searchPageSize,
            );
            $rows = $page['rows'];

            $nextCursor = null;
            if ($page['hasMore'] && $rows !== []) {
                $last = $rows[\count($rows) - 1];
                $nextCursor = [
                    'startsAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($last->startsAtUtc)),
                    'reference' => $last->reference,
                ];
            }

            return [
                'matches' => array_map(self::match(...), $rows),
                'page' => $this->searchPageMeta($page['hasMore'], $nextCursor),
            ];
        }

        throw new BookingValidationException('mode', 'Unknown privacy request search mode.');
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminPrivacyRequests(array $request): array
    {
        $mode = BookingRequestFields::requiredString($request, 'mode');

        if ($mode === 'detail') {
            $id = BookingRequestFields::requiredInt($request, 'id');
            $record = $this->requests->find($id) ?? throw new PrivacyRequestNotFoundException($id);

            return ['request' => $record->payload()];
        }

        if ($mode === 'history') {
            $cursor = $request['cursor'] ?? null;
            $beforeId = null;
            if ($cursor !== null) {
                if (!\is_array($cursor)) {
                    throw new BookingValidationException('cursor', 'History cursor is malformed.');
                }
                /** @var array<string, mixed> $cursor */
                $beforeId = BookingRequestFields::requiredInt($cursor, 'id');
            }

            $page = $this->requests->page($beforeId, $this->policy->historyPageSize);
            $rows = $page['rows'];
            $nextCursor = null;
            if ($page['hasMore'] && $rows !== []) {
                $nextCursor = ['id' => $rows[\count($rows) - 1]->id];
            }

            return [
                'requests' => array_map(static fn (PrivacyRequest $record): array => $record->payload(), $rows),
                'page' => [
                    'pageSize' => $this->policy->historyPageSize,
                    'hasMore' => $page['hasMore'],
                    'nextCursor' => $page['hasMore'] ? $nextCursor : null,
                ],
            ];
        }

        throw new BookingValidationException('mode', 'Unknown privacy request query mode.');
    }

    /**
     * Records the reviewed scope. Every selected reference is resolved
     * against a stored, non-erased booking first, so the register can never
     * name a booking that does not exist or has already been anonymised.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminRecordPrivacyRequest(array $request): array
    {
        $type = BookingRequestFields::requiredString($request, 'type');
        if (!$this->policy->acceptsType($type)) {
            throw new BookingValidationException('type', 'Privacy request type is not one of the frozen V1 types.');
        }
        $received = BookingRequestFields::date(
            BookingRequestFields::requiredString($request, 'receivedDate'),
            'receivedDate',
        );

        $references = $request['bookingReferences'] ?? null;
        if (!\is_array($references) || !array_is_list($references)) {
            throw new BookingValidationException('bookingReferences', 'Booking references must be a list.');
        }
        if (\count($references) > $this->policy->maxBookingReferences) {
            throw new BookingValidationException('bookingReferences', 'Too many booking references for one request.');
        }
        $selected = [];
        foreach ($references as $reference) {
            if (!\is_string($reference)) {
                throw new BookingValidationException('bookingReferences', 'A booking reference is not a string.');
            }
            if (\in_array($reference, $selected, true)) {
                throw new BookingValidationException('bookingReferences', 'A booking reference is selected twice.');
            }
            $booking = $this->bookings->find($reference);
            if ($booking === null || $booking->customerDataErasedAt !== null) {
                throw new BookingNotFoundException($reference);
            }
            $selected[] = $reference;
        }

        return ['request' => $this->requests->record($type, $received, $selected)->payload()];
    }

    /** @return array<string, mixed> */
    private static function match(Booking $booking): array
    {
        return [
            'reference' => $booking->reference,
            'serviceKeys' => $booking->serviceKeys(),
            'state' => $booking->state->value,
            'startsAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->startsAtUtc)),
            'endsAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->endsAtUtc)),
            'customerName' => $booking->customerName,
        ];
    }

    /**
     * @param array{startsAtUtc: string, reference: string}|null $nextCursor
     * @return array{pageSize: int, hasMore: bool, nextCursor: array{startsAtUtc: string, reference: string}|null}
     */
    private function searchPageMeta(bool $hasMore, ?array $nextCursor): array
    {
        return [
            'pageSize' => $this->policy->searchPageSize,
            'hasMore' => $hasMore,
            'nextCursor' => $hasMore ? $nextCursor : null,
        ];
    }
}
