<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/** MySQL persistence for appointment creation and explicit state transitions. */
final class BookingRepository
{
    private const SELECT_COLUMNS = 'id, reference, service_key, state, starts_at_utc, ends_at_utc,'
        . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
        . ' consent_at_utc, cancelled_at_utc, cancellation_reason, customer_data_erased_at,'
        . ' created_at, updated_at, state_changed_at';

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
        private readonly BookableServiceRepository $services,
        private readonly BookingStateMachine $states,
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
            'SELECT reference, service_key, starts_at_utc, ends_at_utc, customer_name'
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

        /** @var list<array{reference: string, service_key: string, starts_at_utc: string, ends_at_utc: string, customer_name: string}> $listed */
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

    public function createConfirmed(
        string $serviceKey,
        \DateTimeImmutable $startsAt,
        \DateTimeImmutable $endsAt,
        string $customerName,
        string $customerEmail,
        ?string $customerPhone,
        ?string $customerNote,
        \DateTimeImmutable $consentAt,
    ): Booking {
        $service = $this->services->find($serviceKey);
        if ($service === null) {
            throw new BookableServiceNotFoundException($serviceKey);
        }
        if (!$service->isActive) {
            throw new BookingValidationException('serviceKey', 'The bookable service is inactive.');
        }

        $start = $startsAt->setTimezone(new \DateTimeZone('UTC'));
        $end = $endsAt->setTimezone(new \DateTimeZone('UTC'));
        if ($end <= $start) {
            throw new BookingValidationException('endsAt', 'Booking end must be after its start.');
        }
        $durationSeconds = $end->getTimestamp() - $start->getTimestamp();
        if ($durationSeconds !== $service->durationMinutes * 60) {
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

        $reference = 'bk_' . bin2hex(random_bytes(16));
        $now = $this->clock->nowIso();
        $initial = $this->states->initial();

        $this->database->run(
            'INSERT INTO bookings (reference, service_key, state, starts_at_utc, ends_at_utc,'
            . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
            . ' consent_at_utc, created_at, updated_at, state_changed_at)'
            . ' VALUES (:reference, :service, :state, :starts, :ends, :timezone, :name, :email,'
            . ' :phone, :note, :consent, :created, :updated, :state_changed)',
            [
                'reference' => $reference,
                'service' => $serviceKey,
                'state' => $initial->value,
                'starts' => $this->time->databaseUtc($start),
                'ends' => $this->time->databaseUtc($end),
                'timezone' => $this->contract->timezone,
                'name' => $customerName,
                'email' => $customerEmail,
                'phone' => $customerPhone,
                'note' => $customerNote,
                'consent' => $this->time->databaseUtc($consentAt),
                'created' => $now,
                'updated' => $now,
                'state_changed' => $now,
            ],
        );

        $booking = $this->find($reference);
        if ($booking === null) {
            throw new \RuntimeException('The booking disappeared immediately after insertion.');
        }

        return $booking;
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
     * Returns only blocking appointments, expanded by the booked service's own
     * buffers. Cancelled rows remain stored but never occupy time.
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
        $parameters = [
            'from_utc' => $this->time->databaseUtc($from),
            'until_utc' => $this->time->databaseUtc($until),
        ];
        if ($excludeReference !== null) {
            if (preg_match('/^bk_[0-9a-f]{32}$/D', $excludeReference) !== 1) {
                throw new BookingValidationException('reference', 'Booking reference is malformed.');
            }
            $parameters['exclude_reference'] = $excludeReference;
        }

        $rows = $this->database->fetchAll(
            'SELECT DATE_SUB(b.starts_at_utc, INTERVAL s.buffer_before_minutes MINUTE) AS occupied_start,'
            . ' DATE_ADD(b.ends_at_utc, INTERVAL s.buffer_after_minutes MINUTE) AS occupied_end'
            . ' FROM bookings b INNER JOIN booking_services s ON s.service_key = b.service_key'
            . " WHERE b.state <> 'cancelled'"
            . $exclude
            . ' AND DATE_SUB(b.starts_at_utc, INTERVAL s.buffer_before_minutes MINUTE) < :until_utc'
            . ' AND DATE_ADD(b.ends_at_utc, INTERVAL s.buffer_after_minutes MINUTE) > :from_utc'
            . ' ORDER BY occupied_start, occupied_end, b.id',
            $parameters,
        );

        return array_map(static function (array $row): OccupiedInterval {
            $start = $row['occupied_start'] ?? null;
            $end = $row['occupied_end'] ?? null;
            if (!\is_string($start) || !\is_string($end)) {
                throw new \RuntimeException('Booking occupancy row is malformed.');
            }

            return new OccupiedInterval(
                new \DateTimeImmutable($start, new \DateTimeZone('UTC')),
                new \DateTimeImmutable($end, new \DateTimeZone('UTC')),
            );
        }, $rows);
    }

    public function move(Booking $booking, \DateTimeImmutable $start, \DateTimeImmutable $end): Booking
    {
        $this->assertCustomerDataLive($booking);

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
