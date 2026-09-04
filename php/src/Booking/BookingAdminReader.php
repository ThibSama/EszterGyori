<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * Admin booking reads and the operational summary (ESZ-106).
 *
 * Owns the range/reference query semantics (including the typed keyset and
 * history cursors, the history page bound and the summary window) and maps
 * stored rows to the current-state admin booking facts. It never writes; the
 * mutation responses that echo the same facts reuse {@see BookingPayloads}.
 */
final class BookingAdminReader
{
    public function __construct(
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
        private readonly Clock $clock,
        private readonly SlotAvailability $availability,
        private readonly BookingRepository $bookings,
        private readonly BookingHistoryRepository $history,
    ) {
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminQuery(array $request): array
    {
        $mode = BookingRequestFields::requiredString($request, 'mode');

        if ($mode === 'reference') {
            $booking = $this->bookings->find(BookingRequestFields::requiredString($request, 'reference'));
            if ($booking === null) {
                throw new BookingNotFoundException(BookingRequestFields::requiredString($request, 'reference'));
            }

            // ESZ-145: the reference read is the only admin surface that
            // serves history, and it serves exactly one bounded page beside
            // the booking's current facts. The typed cursor names the id of
            // the last event the previous page exposed; the page begins
            // strictly after it, so the walk advances until the trail ends.
            $cursor = $request['historyCursor'] ?? null;
            $afterId = null;
            if ($cursor !== null) {
                if (!\is_array($cursor)) {
                    throw new BookingValidationException('historyCursor', 'History cursor is malformed.');
                }
                /** @var array<string, mixed> $cursor */
                $afterId = self::historyCursorEventId($cursor);
            }

            $page = $this->history->pageForBooking(
                $booking->id,
                $this->contract->adminHistoryPageSize,
                $afterId,
            );

            $events = array_map(
                static fn (BookingHistoryEvent $event): array => self::historyEventPayload($event),
                $page['events'],
            );

            $nextCursor = null;
            if ($page['hasMore'] && $page['events'] !== []) {
                $last = $page['events'][\count($page['events']) - 1];
                $nextCursor = ['eventId' => $last->id];
            }

            return [
                'booking' => BookingPayloads::adminBookingPayload($booking),
                'historyPage' => [
                    'pageSize' => $this->contract->adminHistoryPageSize,
                    'hasMore' => $page['hasMore'],
                    'nextCursor' => $page['hasMore'] ? $nextCursor : null,
                    'events' => $events,
                ],
            ];
        }

        if ($mode === 'range') {
            $from = BookingRequestFields::date(
                BookingRequestFields::requiredString($request, 'fromDate'),
                'fromDate',
            );
            $until = BookingRequestFields::date(
                BookingRequestFields::requiredString($request, 'untilDate'),
                'untilDate',
            );
            $days = (int) $from->diff($until)->format('%r%a') + 1;
            if ($days < 1 || $days > $this->contract->slotMaxHorizonDays) {
                throw new BookingValidationException('untilDate', 'Admin booking range is invalid or too large.');
            }
            [$fromUtc, $untilUtc] = $this->availability->utcDayRange($from->format('Y-m-d'), $until->format('Y-m-d'));

            // ESZ-144: the typed keyset cursor. The schema already guarantees
            // both keys exist and are well-formed; the domain re-validates that
            // the continuation actually points inside this window, so a cursor
            // from another range cannot restart or truncate this walk. The row
            // strictly after the cursor keys is where the next page begins.
            $cursor = $request['cursor'] ?? null;
            $anchorStart = null;
            $anchorReference = null;
            if ($cursor !== null) {
                if (!\is_array($cursor)) {
                    throw new BookingValidationException('cursor', 'Booking cursor is malformed.');
                }
                /** @var array<string, mixed> $cursor */
                $cursorInstant = BookingRequestFields::timestamp($cursor, 'startsAtUtc');
                $cursorReference = BookingRequestFields::requiredString($cursor, 'reference');
                if ($cursorInstant < $fromUtc || $cursorInstant >= $untilUtc) {
                    throw new BookingValidationException(
                        'cursor',
                        'Booking cursor is outside the requested range.',
                    );
                }
                $anchorStart = $this->time->databaseUtc($cursorInstant);
                $anchorReference = $cursorReference;
            }

            $page = $this->bookings->pageBetween(
                $fromUtc,
                $untilUtc,
                $anchorStart,
                $anchorReference,
                $this->contract->adminRangePageSize,
            );
            $bookings = $page['rows'];

            // hasMore was decided by the pageSize+1 probe; the next cursor is
            // the last returned row's own keys, which is what makes the walk
            // strictly advance until the range is exhausted.
            $nextCursor = null;
            if ($page['hasMore'] && $bookings !== []) {
                $last = $bookings[\count($bookings) - 1];
                $nextCursor = [
                    'startsAtUtc' => IsoTimestamp::format(
                        BookingRequestFields::databaseInstant($last->startsAtUtc),
                    ),
                    'reference' => $last->reference,
                ];
            }

            return [
                'bookings' => array_map(BookingPayloads::adminBookingPayload(...), $bookings),
                'page' => $this->pageMeta($page['hasMore'], $nextCursor),
            ];
        }

        throw new BookingValidationException('mode', 'Unknown admin booking query mode.');
    }

    /**
     * ESZ-065/ESZ-144 — the operational summary.
     *
     * Counts and the next confirmed instant are exact SQL aggregations over
     * the whole `[today, untilDate]` window — never arithmetic over a detail
     * list, so no bounded list can make a count wrong and cancelled rows can
     * never hide a confirmed appointment. The confirmed-entry collections are
     * each bounded at the domain's `adminSummaryListedEntriesMax`; the
     * `listings` flags say whether each collection is complete, so the
     * operator always knows the counts are authoritative and the list may not
     * be. Cancelled bookings are counted in their own fields and never appear
     * in a listed entry.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminSummary(array $request): array
    {
        $upcomingDays = BookingRequestFields::requiredInt($request, 'upcomingDays');
        if ($upcomingDays < 1 || $upcomingDays > $this->contract->slotMaxHorizonDays) {
            throw new BookingValidationException('upcomingDays', 'Summary horizon is outside the supported range.');
        }

        $zone = new \DateTimeZone($this->contract->timezone);
        $now = $this->clock->now();
        $today = $now->setTimezone($zone)->format('Y-m-d');
        $untilDate = BookingRequestFields::date($today, 'todayDate')
            ->modify('+' . ($upcomingDays - 1) . ' days')
            ->format('Y-m-d');
        [$fromUtc, $untilUtc] = $this->availability->utcDayRange($today, $untilDate);
        // The partition boundary between "today" and "upcoming" is the end of
        // the Paris-local today: the same civil cut the entries use.
        $endOfTodayUtc = $this->time->localToUtcWithFoldOffset(
            BookingRequestFields::date($today, 'todayDate')->modify('+1 day')->format('Y-m-d') . ' 00:00:00',
            null,
        );
        $maxListed = $this->contract->adminSummaryListedEntriesMax;

        $counts = $this->bookings->summaryCountsBetween($fromUtc, $endOfTodayUtc, $untilUtc);
        $todayListed = $this->bookings->summaryConfirmedEntries($fromUtc, $endOfTodayUtc, $maxListed);
        $upcomingListed = $this->bookings->summaryConfirmedEntries($endOfTodayUtc, $untilUtc, $maxListed);

        $nextStored = $this->bookings->nextConfirmedStartUtc($now, $untilUtc);

        return [
            'timezone' => $this->contract->timezone,
            'todayDate' => $today,
            'untilDate' => $untilDate,
            'upcomingDays' => $upcomingDays,
            'counts' => $counts,
            'nextConfirmedStartsAtUtc' => $nextStored === null
                ? null
                : IsoTimestamp::format(BookingRequestFields::databaseInstant($nextStored)),
            'listings' => [
                'todayComplete' => $todayListed['complete'],
                'upcomingComplete' => $upcomingListed['complete'],
            ],
            'today' => array_map(
                fn (array $row): array => $this->summaryEntryFromRow($row, $zone),
                $todayListed['rows'],
            ),
            'upcoming' => array_map(
                fn (array $row): array => $this->summaryEntryFromRow($row, $zone),
                $upcomingListed['rows'],
            ),
        ];
    }

    /**
     * @param array{startsAtUtc: string, reference: string}|null $nextCursor
     * @return array{pageSize: int, hasMore: bool, nextCursor: array{startsAtUtc: string, reference: string}|null}
     */
    private function pageMeta(bool $hasMore, ?array $nextCursor): array
    {
        return [
            'pageSize' => $this->contract->adminRangePageSize,
            'hasMore' => $hasMore,
            'nextCursor' => $hasMore ? $nextCursor : null,
        ];
    }

    /**
     * @param array{
     *     reference: string,
     *     service_key: string,
     *     starts_at_utc: string,
     *     ends_at_utc: string,
     *     customer_name: string
     * } $row
     * @return array<string, mixed>
     */
    private function summaryEntryFromRow(array $row, \DateTimeZone $zone): array
    {
        $start = BookingRequestFields::databaseInstant($row['starts_at_utc']);
        $local = $start->setTimezone($zone);

        return [
            'reference' => $row['reference'],
            'serviceKey' => $row['service_key'],
            'startsAtUtc' => IsoTimestamp::format($start),
            'endsAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($row['ends_at_utc'])),
            'localDate' => $local->format('Y-m-d'),
            'localStart' => $local->format('H:i'),
            'customerName' => $row['customer_name'],
        ];
    }

    /** @return array{type: string, actor: string, occurredAt: string} */
    private static function historyEventPayload(BookingHistoryEvent $event): array
    {
        return [
            'type' => $event->type,
            'actor' => $event->actor,
            'occurredAt' => $event->occurredAt,
        ];
    }

    /**
     * ESZ-145 — the typed history continuation, re-validated in the domain.
     *
     * The schema already guarantees the cursor is an object with an integer
     * `eventId`; the domain re-checks that the id is positive, because a
     * continuation can never legitimately point at or before the first row.
     *
     * @param array<string, mixed> $cursor
     */
    private static function historyCursorEventId(array $cursor): int
    {
        $eventId = $cursor['eventId'] ?? null;
        if (!\is_int($eventId) || $eventId < 1) {
            throw new BookingValidationException('historyCursor', 'History cursor is malformed.');
        }

        return $eventId;
    }
}
