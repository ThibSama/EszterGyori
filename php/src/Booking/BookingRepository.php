<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/** MySQL persistence for appointment creation and explicit state transitions. */
final class BookingRepository
{
    private const SELECT_COLUMNS = 'id, reference, service_key, combination_key, state, starts_at_utc, ends_at_utc,'
        . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
        . ' consent_at_utc, consent_notice_id, cancelled_at_utc, cancellation_reason, customer_data_erased_at,'
        . ' created_at, updated_at, state_changed_at';

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
        private readonly BookableServiceRepository $services,
        private readonly BookingStateMachine $states,
        /**
         * ESZ-150 — needed only to store a combination booking; a caller
         * that never passes a combination key may leave it out.
         */
        private readonly ?ServiceCombinationRepository $combinations = null,
    ) {
    }

    public function find(string $reference): ?Booking
    {
        if (preg_match('/^bk_[0-9a-f]{32}$/D', $reference) !== 1) {
            throw new BookingValidationException('reference', 'Booking reference is malformed.');
        }

        $row = $this->database->fetchOne(
            'SELECT ' . self::SELECT_COLUMNS . ' FROM bookings WHERE reference = :reference',
            ['reference' => $reference],
        );

        return $row === null ? null : Booking::fromRow($row, $this->contract);
    }

    public function findForUpdate(string $reference): ?Booking
    {
        if (preg_match('/^bk_[0-9a-f]{32}$/D', $reference) !== 1) {
            throw new BookingValidationException('reference', 'Booking reference is malformed.');
        }

        $row = $this->database->fetchOne(
            'SELECT ' . self::SELECT_COLUMNS . ' FROM bookings WHERE reference = :reference FOR UPDATE',
            ['reference' => $reference],
        );

        return $row === null ? null : Booking::fromRow($row, $this->contract);
    }

    /**
     * ESZ-144 — one explicit page of an admin range read.
     *
     * Rows are start-anchored: a booking is in the window when its
     * `starts_at_utc` falls in `[fromUtc, untilUtc)`, which is exactly the set
     * of bookings whose Paris-local start date lies inside the requested civil
     * dates. Pagination is deterministic keyset order on
     * `(starts_at_utc, reference)` — the reference tie-break is what keeps two
     * bookings at the same instant from duplicating or skipping across pages —
     * and the anchor names the strictly-later continuation point.
     *
     * `pageSize` is validated against the domain's own ceiling, and the query
     * fetches at most `pageSize + 1` rows so `hasMore` is detected from the
     * surplus row: a page is never silently clipped at some other cap, because
     * there is no other cap left — the old ESZ-085 `LIMIT maxResults` clip is
     * gone with the whole method that carried it.
     *
     * @param string|null $afterStartsAtUtc Continuation keys in database form
     *     (`Y-m-d H:i:s.v`), both or neither.
     * @return array{rows: list<Booking>, hasMore: bool}
     */
    public function pageBetween(
        \DateTimeImmutable $fromUtc,
        \DateTimeImmutable $untilUtc,
        ?string $afterStartsAtUtc,
        ?string $afterReference,
        int $pageSize,
    ): array {
        if ($untilUtc <= $fromUtc) {
            throw new BookingValidationException('untilUtc', 'Booking query range must be increasing.');
        }
        if ($pageSize < 1 || $pageSize > $this->contract->adminRangePageSize) {
            throw new BookingValidationException('pageSize', 'Booking page size is outside the contract bounds.');
        }
        if (($afterStartsAtUtc === null) !== ($afterReference === null)) {
            throw new BookingValidationException('cursor', 'Booking cursor keys must be provided together.');
        }

        $after = $afterStartsAtUtc !== null
            ? ' AND (starts_at_utc > :anchor_gt'
                . ' OR (starts_at_utc = :anchor_eq AND reference > :anchor_reference))'
            : '';
        $parameters = [
            'from_utc' => $this->time->databaseUtc($fromUtc),
            'until_utc' => $this->time->databaseUtc($untilUtc),
        ];
        if ($afterStartsAtUtc !== null && $afterReference !== null) {
            // Native prepares bind each named marker once, so the anchor
            // instant is bound twice under two names rather than reused.
            $parameters['anchor_gt'] = $afterStartsAtUtc;
            $parameters['anchor_eq'] = $afterStartsAtUtc;
            $parameters['anchor_reference'] = $afterReference;
        }

        $rows = $this->database->fetchAll(
            'SELECT ' . self::SELECT_COLUMNS . ' FROM bookings'
            . ' WHERE starts_at_utc >= :from_utc AND starts_at_utc < :until_utc'
            . $after
            . ' ORDER BY starts_at_utc, reference'
            . ' LIMIT ' . ($pageSize + 1),
            $parameters,
        );

        $hasMore = \count($rows) > $pageSize;

        return [
            'rows' => array_map(
                fn (array $row): Booking => Booking::fromRow($row, $this->contract),
                \array_slice($rows, 0, $pageSize),
            ),
            'hasMore' => $hasMore,
        ];
    }

    /**
     * ESZ-144 — exact operational counts for the summary window.
     *
     * A dedicated aggregation, partitioned the same way the entries are: a
     * start is "today" while it precedes the end of the Paris-local today
     * (`$endOfTodayUtc`), otherwise "upcoming", inside the half-open
     * `[fromUtc, untilUtc)` window. The summary never counts over a detail
     * list, so no bounded list can make a count wrong and cancelled rows can
     * never hide a confirmed one from the confirmed numbers.
     *
     * @return array{todayConfirmed: int, todayCancelled: int, upcomingConfirmed: int, upcomingCancelled: int}
     */
    public function summaryCountsBetween(
        \DateTimeImmutable $fromUtc,
        \DateTimeImmutable $endOfTodayUtc,
        \DateTimeImmutable $untilUtc,
    ): array {
        $rows = $this->database->fetchAll(
            'SELECT state,'
            . ' CASE WHEN starts_at_utc < :end_today THEN \'today\' ELSE \'upcoming\' END AS bucket,'
            . ' COUNT(*) AS n'
            . ' FROM bookings'
            . ' WHERE starts_at_utc >= :from_utc AND starts_at_utc < :until_utc'
            . " AND state IN ('confirmed', 'cancelled')"
            . ' GROUP BY state, bucket',
            [
                'from_utc' => $this->time->databaseUtc($fromUtc),
                'end_today' => $this->time->databaseUtc($endOfTodayUtc),
                'until_utc' => $this->time->databaseUtc($untilUtc),
            ],
        );

        $counts = [
            'todayConfirmed' => 0,
            'todayCancelled' => 0,
            'upcomingConfirmed' => 0,
            'upcomingCancelled' => 0,
        ];

        foreach ($rows as $row) {
            $state = $row['state'] ?? null;
            $bucket = $row['bucket'] ?? null;
            $n = $row['n'] ?? null;
            if (!\is_string($state) || !\is_string($bucket) || (!\is_int($n) && !\is_string($n))) {
                throw new \RuntimeException('Summary aggregation row is malformed.');
            }
            $n = (int) $n;

            if ($bucket === 'today') {
                if ($state === 'confirmed') {
                    $counts['todayConfirmed'] += $n;
                } elseif ($state === 'cancelled') {
                    $counts['todayCancelled'] += $n;
                } else {
                    throw new \RuntimeException("Summary aggregation met an unexpected {$state} state.");
                }

                continue;
            }

            if ($bucket === 'upcoming') {
                if ($state === 'confirmed') {
                    $counts['upcomingConfirmed'] += $n;
                } elseif ($state === 'cancelled') {
                    $counts['upcomingCancelled'] += $n;
                } else {
                    throw new \RuntimeException("Summary aggregation met an unexpected {$state} state.");
                }

                continue;
            }

            throw new \RuntimeException("Summary aggregation returned an unexpected {$bucket} bucket.");
        }

        return $counts;
    }

    /**
     * ESZ-144 — one bounded confirmed-entry collection for the summary.
     *
     * Only `state = 'confirmed'` rows are ever listed, so a cancelled booking
     * cannot occupy a place a confirmed entry should hold. The read fetches
     * `$max + 1` rows: `complete` is false exactly when a further confirmed
     * entry exists past the bound, and the caller then says so on the wire
     * instead of letting the collection masquerade as the whole answer.
     *
     * @return array{
     *     rows: list<array{
     *         reference: string,
     *         service_key: string,
     *         combination_key: ?string,
     *         starts_at_utc: string,
     *         ends_at_utc: string,
     *         customer_name: string
     *     }>,
     *     complete: bool
     * }
     */
    public function summaryConfirmedEntries(
        \DateTimeImmutable $fromUtc,
        \DateTimeImmutable $untilUtc,
        int $max,
    ): array {
        if ($max < 1 || $max > $this->contract->adminSummaryListedEntriesMax) {
            throw new BookingValidationException('max', 'Summary listing bound is outside the contract bounds.');
        }

        $rows = $this->database->fetchAll(
            'SELECT reference, service_key, combination_key, starts_at_utc, ends_at_utc, customer_name'
            . ' FROM bookings'
            . ' WHERE starts_at_utc >= :from_utc AND starts_at_utc < :until_utc'
            . " AND state = 'confirmed'"
            . ' ORDER BY starts_at_utc, reference'
            . ' LIMIT ' . ($max + 1),
            [
                'from_utc' => $this->time->databaseUtc($fromUtc),
                'until_utc' => $this->time->databaseUtc($untilUtc),
            ],
        );

        /** @var list<array{reference: string, service_key: string, combination_key: ?string, starts_at_utc: string, ends_at_utc: string, customer_name: string}> $listed */
        $listed = \array_slice($rows, 0, $max);

        return ['rows' => $listed, 'complete' => \count($rows) <= $max];
    }

    /**
     * ESZ-144 — the exact next confirmed booking of the summary window.
     *
     * A dedicated SQL minimum, so the answer is exact over the full period and
     * cancelled rows preceding the next appointment can never hide it. Returns
     * the raw database instant, or null when no confirmed booking starts at or
     * after `nowUtc` inside the window.
     */
    public function nextConfirmedStartUtc(
        \DateTimeImmutable $nowUtc,
        \DateTimeImmutable $untilUtc,
    ): ?string {
        $row = $this->database->fetchOne(
            'SELECT starts_at_utc FROM bookings'
            . ' WHERE state = \'confirmed\''
            . ' AND starts_at_utc >= :now_utc AND starts_at_utc < :until_utc'
            . ' ORDER BY starts_at_utc, reference'
            . ' LIMIT 1',
            [
                'now_utc' => $this->time->databaseUtc($nowUtc),
                'until_utc' => $this->time->databaseUtc($untilUtc),
            ],
        );

        $value = $row['starts_at_utc'] ?? null;

        return \is_string($value) ? $value : null;
    }

    /**
     * Inserts the initial confirmed booking row.
     *
     * @param \DateTimeImmutable $consentAt the instant the visitor accepted
     * @param string $consentNoticeId ESZ-142 — the catalog id of the notice
     *     the visitor accepted; the caller (PdoBookingApi) has already checked
     *     membership against the booking-domain artifact, and every new
     *     booking stores a non-null id beside consent_at_utc.
     * @param ?string $combinationKey ESZ-150 — the validated combination the
     *     booking is for, whose first canonical member `$serviceKey` must be;
     *     null for a single-service booking. The interval must then equal the
     *     combination's *validated* duration, never a sum of its members.
     * @param ?BookableOffer $offer ESZ-153 — the offer the lifecycle
     *     revalidated under the serialization boundary; its buffers become
     *     the booking's own snapshot. It must name the same service and
     *     combination, and its shaping facts must equal the catalog rows this
     *     method re-reads under the same boundary (defence in depth, exactly
     *     like the duration check). Null — a direct repository caller — stores
     *     the catalog's current buffers for the same identity.
     */
    public function createConfirmed(
        string $serviceKey,
        \DateTimeImmutable $startsAt,
        \DateTimeImmutable $endsAt,
        string $customerName,
        string $customerEmail,
        ?string $customerPhone,
        ?string $customerNote,
        \DateTimeImmutable $consentAt,
        string $consentNoticeId,
        ?string $combinationKey = null,
        ?BookableOffer $offer = null,
    ): Booking {
        $service = $this->services->find($serviceKey);
        if ($service === null) {
            throw new BookableServiceNotFoundException($serviceKey);
        }
        if (!$service->isActive) {
            throw new BookingValidationException('serviceKey', 'The bookable service is inactive.');
        }
        $expectedDurationMinutes = $service->durationMinutes;
        $bufferBeforeMinutes = $service->bufferBeforeMinutes;
        $bufferAfterMinutes = $service->bufferAfterMinutes;
        if ($combinationKey !== null) {
            $combination = $this->bookableCombination($combinationKey, $serviceKey);
            $expectedDurationMinutes = $combination->durationMinutes;
            $bufferBeforeMinutes = $combination->bufferBeforeMinutes;
            $bufferAfterMinutes = $combination->bufferAfterMinutes;
        }
        // ESZ-153: the snapshot is the revalidated offer's, and the offer must
        // agree with the catalog as read here under the same boundary.
        if ($offer !== null) {
            if (
                $offer->serviceKey !== $serviceKey
                || $offer->combinationKey !== $combinationKey
                || $offer->durationMinutes !== $expectedDurationMinutes
                || $offer->bufferBeforeMinutes !== $bufferBeforeMinutes
                || $offer->bufferAfterMinutes !== $bufferAfterMinutes
            ) {
                throw new BookingValidationException(
                    'offer',
                    'The revalidated offer disagrees with the catalog under the serialization boundary.',
                );
            }
        }

        $start = $startsAt->setTimezone(new \DateTimeZone('UTC'));
        $end = $endsAt->setTimezone(new \DateTimeZone('UTC'));
        if ($end <= $start) {
            throw new BookingValidationException('endsAt', 'Booking end must be after its start.');
        }
        $durationSeconds = $end->getTimestamp() - $start->getTimestamp();
        if ($durationSeconds !== $expectedDurationMinutes * 60) {
            throw new BookingValidationException(
                'endsAt',
                'Booking interval must equal the provisioned service duration.',
            );
        }

        $customerName = trim($customerName);
        $customerEmail = trim($customerEmail);
        $customerPhone = self::optional($customerPhone);
        $customerNote = self::optional($customerNote);
        $this->validateCustomer($customerName, $customerEmail, $customerPhone, $customerNote);
        // ESZ-142: the repository re-checks the notice id against the same
        // artifact the API layer used, so no code path can persist an id the
        // immutable catalog does not contain.
        if (!$this->contract->acceptsConsentNoticeId($consentNoticeId)) {
            throw new BookingValidationException('consentNoticeId', 'Unknown booking consent notice.');
        }

        $reference = 'bk_' . bin2hex(random_bytes(16));
        $now = $this->clock->nowIso();
        $initial = $this->states->initial();

        $this->database->run(
            'INSERT INTO bookings (reference, service_key, combination_key, state, starts_at_utc, ends_at_utc,'
            . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
            . ' consent_at_utc, consent_notice_id, created_at, updated_at, state_changed_at)'
            . ' VALUES (:reference, :service, :combination, :state, :starts, :ends, :timezone, :name, :email,'
            . ' :phone, :note, :consent, :consent_notice, :created, :updated, :state_changed)',
            [
                'reference' => $reference,
                'service' => $serviceKey,
                'combination' => $combinationKey,
                'state' => $initial->value,
                'starts' => $this->time->databaseUtc($start),
                'ends' => $this->time->databaseUtc($end),
                'timezone' => $this->contract->timezone,
                'name' => $customerName,
                'email' => $customerEmail,
                'phone' => $customerPhone,
                'note' => $customerNote,
                'consent' => $this->time->databaseUtc($consentAt),
                'consent_notice' => $consentNoticeId,
                'created' => $now,
                'updated' => $now,
                'state_changed' => $now,
            ],
        );

        $booking = $this->find($reference);
        if ($booking === null) {
            throw new \RuntimeException('The booking disappeared immediately after insertion.');
        }

        // ESZ-153: the booking's own buffer snapshot, written once in the
        // same transaction and never updated. From here on the interval this
        // booking occupies depends on its own rows only.
        $this->database->run(
            'INSERT INTO booking_buffer_snapshots'
            . ' (booking_id, buffer_before_minutes, buffer_after_minutes, origin, frozen_at)'
            . ' VALUES (:booking_id, :before, :after, :origin, :frozen_at)',
            [
                'booking_id' => $booking->id,
                'before' => $bufferBeforeMinutes,
                'after' => $bufferAfterMinutes,
                'origin' => BookingBufferSnapshot::ORIGIN_OFFER,
                'frozen_at' => $now,
            ],
        );

        return $booking;
    }

    /**
     * ESZ-153 — the buffers a booking was confirmed with: its own snapshot
     * row, never the catalog. Every booking owns one (creation writes it,
     * migration 0019 and the restore reconciliation freeze the legacy ones),
     * so a missing row is a broken invariant, not a fallback case.
     */
    public function bufferSnapshot(Booking $booking): BookingBufferSnapshot
    {
        $row = $this->database->fetchOne(
            'SELECT buffer_before_minutes, buffer_after_minutes, origin'
            . ' FROM booking_buffer_snapshots WHERE booking_id = :booking_id',
            ['booking_id' => $booking->id],
        );
        if ($row === null) {
            throw new \RuntimeException("Booking {$booking->reference} owns no buffer snapshot.");
        }

        return BookingBufferSnapshot::fromRow($row);
    }

    /**
     * ESZ-150 — the combination a new booking names, after the same checks
     * the catalog makes: the row exists, is active, `$serviceKey` is its
     * first canonical member and every member is an active service. Defence
     * in depth beside the offer the lifecycle already revalidated under the
     * boundary. ESZ-153 reads its buffers too, for the booking's snapshot.
     */
    private function bookableCombination(string $combinationKey, string $serviceKey): ServiceCombination
    {
        if ($this->combinations === null) {
            throw new \LogicException('A combination booking needs the combination repository.');
        }
        $combination = $this->combinations->find($combinationKey);
        if ($combination === null) {
            throw new BookableServiceNotFoundException($combinationKey);
        }
        if (!$combination->isActive || $combination->serviceKeys[0] !== $serviceKey) {
            throw new BookingValidationException('combinationKey', 'The combination is not bookable.');
        }
        foreach ($this->combinations->memberServices($combination->serviceKeys) as $member) {
            if (!$member->isActive) {
                throw new BookingValidationException('combinationKey', 'A combination member is inactive.');
            }
        }

        return $combination;
    }

    public function transition(string $reference, string $targetState, ?string $reason = null): Booking
    {
        $target = BookingState::fromString($targetState, $this->contract);

        return $this->database->transactional(function () use ($reference, $target, $reason): Booking {
            if (preg_match('/^bk_[0-9a-f]{32}$/D', $reference) !== 1) {
                throw new BookingValidationException('reference', 'Booking reference is malformed.');
            }

            $row = $this->database->fetchOne(
                'SELECT ' . self::SELECT_COLUMNS . ' FROM bookings WHERE reference = :reference FOR UPDATE',
                ['reference' => $reference],
            );
            if ($row === null) {
                throw new BookingNotFoundException($reference);
            }

            $booking = Booking::fromRow($row, $this->contract);
            $this->assertCustomerDataLive($booking);
            $next = $this->states->transition($booking->state, $target);
            // ESZ-139: one derived mutation instant, strictly later than the
            // row's own updatedAt, drives every advancing state timestamp of
            // the transition — updated_at, state_changed_at and (when
            // cancelling) cancelled_at_utc — so the stored facts can never
            // disagree about when the transition happened.
            $mutationInstant = $this->mutationInstant($booking->updatedAt);
            $mutationIso = IsoTimestamp::format($mutationInstant);
            $cancelledAt = $next->value === 'cancelled'
                ? $this->time->databaseUtc($mutationInstant)
                : null;
            $reason = $next->value === 'cancelled' ? self::optional($reason) : null;

            if ($reason !== null && mb_strlen($reason) > 500) {
                throw new BookingValidationException('cancellationReason', 'Cancellation reason is too long.');
            }

            $this->database->run(
                'UPDATE bookings SET state = :state, cancelled_at_utc = :cancelled_at,'
                . ' cancellation_reason = :reason, updated_at = :updated_at,'
                . ' state_changed_at = :state_changed_at WHERE id = :id',
                [
                    'state' => $next->value,
                    'cancelled_at' => $cancelledAt,
                    'reason' => $reason,
                    'updated_at' => $mutationIso,
                    'state_changed_at' => $mutationIso,
                    'id' => $booking->id,
                ],
            );

            $stored = $this->find($reference);
            if ($stored === null) {
                throw new \RuntimeException('The booking disappeared during its transition.');
            }

            return $stored;
        });
    }

    /**
     * ESZ-152 — the confirmed appointments whose own interval (no buffers)
     * overlaps a half-open UTC interval, in start order: what a strict
     * planning constraint is warned about. A read only; nothing here changes
     * a booking.
     *
     * @return list<Booking>
     */
    public function confirmedOverlapping(\DateTimeImmutable $fromUtc, \DateTimeImmutable $untilUtc): array
    {
        $from = $fromUtc->setTimezone(new \DateTimeZone('UTC'));
        $until = $untilUtc->setTimezone(new \DateTimeZone('UTC'));
        if ($until <= $from) {
            throw new BookingValidationException('untilUtc', 'Overlap range must be increasing.');
        }

        return array_map(
            fn (array $row): Booking => Booking::fromRow($row, $this->contract),
            $this->database->fetchAll(
                'SELECT ' . self::SELECT_COLUMNS . ' FROM bookings'
                . " WHERE state = 'confirmed' AND starts_at_utc < :until_utc AND ends_at_utc > :from_utc"
                . ' ORDER BY starts_at_utc, reference',
                [
                    'from_utc' => $this->time->databaseUtc($from),
                    'until_utc' => $this->time->databaseUtc($until),
                ],
            ),
        );
    }

    /**
     * Returns only blocking appointments, each expanded by the buffers of its
     * own snapshot (ESZ-153). Cancelled rows remain stored but never occupy
     * time.
     *
     * The read never joins the catalog: a booking's occupied interval is
     * `starts_at_utc - before` to `ends_at_utc + after` from its own two rows,
     * so editing a service's or a combination's buffers later reshapes new
     * slots and leaves every confirmed appointment where it was. The SQL
     * prefilter widens the range by the contract's buffer ceiling — the
     * largest any snapshot may hold — and the exact half-open overlap test
     * happens on the snapshotted values in PHP, so a booking that has somehow
     * lost its snapshot is reported rather than silently dropped.
     *
     * @return list<OccupiedInterval>
     */
    public function occupiedBetween(
        \DateTimeImmutable $fromUtc,
        \DateTimeImmutable $untilUtc,
        ?string $excludeReference = null,
    ): array {
        $from = $fromUtc->setTimezone(new \DateTimeZone('UTC'));
        $until = $untilUtc->setTimezone(new \DateTimeZone('UTC'));
        if ($until <= $from) {
            throw new BookingValidationException('untilUtc', 'Occupancy range must be increasing.');
        }

        $exclude = $excludeReference === null ? '' : ' AND b.reference <> :exclude_reference';
        $ceiling = $this->contract->bufferMaxMinutes;
        $parameters = [
            'from_utc' => $this->time->databaseUtc($from->modify('-' . $ceiling . ' minutes')),
            'until_utc' => $this->time->databaseUtc($until->modify('+' . $ceiling . ' minutes')),
        ];
        if ($excludeReference !== null) {
            if (preg_match('/^bk_[0-9a-f]{32}$/D', $excludeReference) !== 1) {
                throw new BookingValidationException('reference', 'Booking reference is malformed.');
            }
            $parameters['exclude_reference'] = $excludeReference;
        }

        $rows = $this->database->fetchAll(
            'SELECT b.reference, b.starts_at_utc, b.ends_at_utc,'
            . ' ss.buffer_before_minutes, ss.buffer_after_minutes, ss.origin'
            . ' FROM bookings b LEFT JOIN booking_buffer_snapshots ss ON ss.booking_id = b.id'
            . " WHERE b.state <> 'cancelled'"
            . $exclude
            . ' AND b.starts_at_utc < :until_utc AND b.ends_at_utc > :from_utc'
            . ' ORDER BY b.starts_at_utc, b.ends_at_utc, b.id',
            $parameters,
        );

        $occupied = [];
        foreach ($rows as $row) {
            $reference = $row['reference'] ?? null;
            $start = $row['starts_at_utc'] ?? null;
            $end = $row['ends_at_utc'] ?? null;
            if (!\is_string($reference) || !\is_string($start) || !\is_string($end)) {
                throw new \RuntimeException('Booking occupancy row is malformed.');
            }
            if (($row['origin'] ?? null) === null) {
                throw new \RuntimeException("Booking {$reference} owns no buffer snapshot.");
            }
            $snapshot = BookingBufferSnapshot::fromRow($row);
            $occupiedStart = BookingRequestFields::databaseInstant($start)
                ->modify('-' . $snapshot->bufferBeforeMinutes . ' minutes');
            $occupiedEnd = BookingRequestFields::databaseInstant($end)
                ->modify('+' . $snapshot->bufferAfterMinutes . ' minutes');
            if ($occupiedStart < $until && $occupiedEnd > $from) {
                $occupied[] = new OccupiedInterval($occupiedStart, $occupiedEnd);
            }
        }

        usort($occupied, static fn (OccupiedInterval $a, OccupiedInterval $b): int =>
            [$a->startsAtUtc, $a->endsAtUtc] <=> [$b->startsAtUtc, $b->endsAtUtc]);

        return $occupied;
    }

    public function move(Booking $booking, \DateTimeImmutable $start, \DateTimeImmutable $end): Booking
    {
        $this->assertCustomerDataLive($booking);
        // ESZ-153: a move relocates the stored interval and never resizes it;
        // the buffer snapshot row is not touched at all.
        if ($end->getTimestamp() - $start->getTimestamp() !== $booking->durationMinutes() * 60) {
            throw new BookingValidationException('endsAt', 'A move must preserve the booking\'s stored duration.');
        }

        // ESZ-139: the derived instant is strictly later than the row's own
        // updatedAt, so a move that succeeds under a frozen or backward
        // application clock still mints a strictly newer token.
        $now = IsoTimestamp::format($this->mutationInstant($booking->updatedAt));
        $this->database->run(
            'UPDATE bookings SET starts_at_utc = :start, ends_at_utc = :end,'
            . ' updated_at = :updated WHERE id = :id',
            [
                'start' => $this->time->databaseUtc($start),
                'end' => $this->time->databaseUtc($end),
                'updated' => $now,
                'id' => $booking->id,
            ],
        );

        return $this->required($booking->reference);
    }

    public function updateCustomer(
        Booking $booking,
        string $name,
        string $email,
        ?string $phone,
        ?string $note,
    ): Booking {
        // ESZ-140: an erased booking holds fixed placeholders and a marker;
        // no customer write may repopulate it. Refused here, at the
        // persistence layer, so no future caller can reintroduce PII either —
        // the schema's erasure CHECK is the second line of defence.
        $this->assertCustomerDataLive($booking);

        $name = trim($name);
        $email = trim($email);
        $phone = self::optional($phone);
        $note = self::optional($note);
        $this->validateCustomer($name, $email, $phone, $note);

        if (
            $booking->customerName === $name
            && $booking->customerEmail === $email
            && $booking->customerPhone === $phone
            && $booking->customerNote === $note
        ) {
            return $booking;
        }

        $this->database->run(
            'UPDATE bookings SET customer_name = :name, customer_email = :email,'
            . ' customer_phone = :phone, customer_note = :note, updated_at = :updated WHERE id = :id',
            [
                'name' => $name,
                'email' => $email,
                'phone' => $phone,
                'note' => $note,
                // ESZ-139: strictly later than the row's own token even under
                // a frozen or backward application clock.
                'updated' => IsoTimestamp::format($this->mutationInstant($booking->updatedAt)),
                'id' => $booking->id,
            ],
        );

        return $this->required($booking->reference);
    }

    /**
     * ESZ-139 — one derived mutation instant per successful booking write.
     *
     * State timestamps advance by exactly this instant, which is the later of
     * the application clock (canonical UTC, millisecond precision) and the
     * row's own `updatedAt` plus one millisecond. The comparison happens in
     * the canonical string domain — fixed-width UTC text, so byte order is
     * chronological order — which makes the result strictly later than the
     * token the mutation was granted against even when the application clock
     * returns the same millisecond or moves backward.
     */
    private function mutationInstant(string $currentUpdatedAt): \DateTimeImmutable
    {
        $nowIso = $this->clock->nowIso();
        if (\strcmp($nowIso, $currentUpdatedAt) > 0) {
            $instant = \DateTimeImmutable::createFromFormat(
                IsoTimestamp::FORMAT,
                $nowIso,
                new \DateTimeZone('UTC'),
            );
            if ($instant === false) {
                throw new \RuntimeException('The application clock produced a non-canonical timestamp.');
            }

            return $instant;
        }

        $current = \DateTimeImmutable::createFromFormat(
            IsoTimestamp::FORMAT,
            $currentUpdatedAt,
            new \DateTimeZone('UTC'),
        );
        if ($current === false) {
            throw new \RuntimeException('The stored booking updated_at is not a canonical timestamp.');
        }

        return $current->modify('+1 millisecond');
    }

    private function required(string $reference): Booking
    {
        $booking = $this->find($reference);
        if ($booking === null) {
            throw new \RuntimeException('Booking disappeared after an update.');
        }

        return $booking;
    }

    /**
     * ESZ-140: refuses any further customer or lifecycle write to a booking
     * whose customer data retention has erased. The retention sweep itself
     * writes through raw SQL and never passes through here.
     */
    private function assertCustomerDataLive(Booking $booking): void
    {
        if ($booking->customerDataErasedAt !== null) {
            throw new BookingValidationException(
                'customerDataErasedAt',
                'This booking\'s customer data was erased by the retention policy; '
                . 'it accepts no further customer or lifecycle writes.',
            );
        }
    }

    private function validateCustomer(string $name, string $email, ?string $phone, ?string $note): void
    {
        if ($name === '' || mb_strlen($name) > 160) {
            throw new BookingValidationException('customerName', 'Customer name is empty or too long.');
        }
        if (mb_strlen($email) > 254 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            throw new BookingValidationException('customerEmail', 'Customer email is invalid.');
        }
        if ($phone !== null && mb_strlen($phone) > 32) {
            throw new BookingValidationException('customerPhone', 'Customer phone is too long.');
        }
        if ($note !== null && mb_strlen($note) > 2000) {
            throw new BookingValidationException('customerNote', 'Customer note is too long.');
        }
    }

    private static function optional(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $trimmed = trim($value);

        return $trimmed === '' ? null : $trimmed;
    }
}
