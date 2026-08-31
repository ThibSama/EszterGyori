<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/** MySQL persistence for appointment creation and explicit state transitions. */
final class BookingRepository
{
    private const SELECT_COLUMNS = 'id, reference, service_key, state, starts_at_utc, ends_at_utc,'
        . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
        . ' consent_at_utc, cancelled_at_utc, cancellation_reason, created_at, updated_at, state_changed_at';

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

    /** @return list<Booking> */
    public function listBetween(\DateTimeImmutable $fromUtc, \DateTimeImmutable $untilUtc): array
    {
        if ($untilUtc <= $fromUtc) {
            throw new BookingValidationException('untilUtc', 'Booking query range must be increasing.');
        }

        return array_map(
            fn (array $row): Booking => Booking::fromRow($row, $this->contract),
            $this->database->fetchAll(
                'SELECT ' . self::SELECT_COLUMNS . ' FROM bookings'
                . ' WHERE starts_at_utc < :until_utc AND ends_at_utc > :from_utc'
                . ' ORDER BY starts_at_utc, reference'
                // ESZ-085: a row cap as well as a date range.
                //
                // The callers bound the range — 90 days at most — and until Package
                // 8.2 that was the only bound there was. A range is not a bound on
                // *rows*: how many bookings fall inside 90 days is decided by how
                // busy the site is, not by the query, so the response size and the
                // memory this method allocates had no ceiling at all. The cap is far
                // above what one practitioner can physically book in a quarter, so
                // it is a guard rather than pagination, and it is the same ceiling
                // the slot engine already applies to the other unbounded list on
                // this surface.
                . ' LIMIT ' . $this->contract->slotMaxResults,
                [
                    'from_utc' => $this->time->databaseUtc($fromUtc),
                    'until_utc' => $this->time->databaseUtc($untilUtc),
                ],
            ),
        );
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
            $next = $this->states->transition($booking->state, $target);
            $nowIso = $this->clock->nowIso();
            $cancelledAt = $next->value === 'cancelled'
                ? $this->time->databaseUtc($this->clock->now())
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
                    'updated_at' => $nowIso,
                    'state_changed_at' => $nowIso,
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
        $now = $this->clock->nowIso();
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
                'updated' => $this->clock->nowIso(),
                'id' => $booking->id,
            ],
        );

        return $this->required($booking->reference);
    }

    private function required(string $reference): Booking
    {
        $booking = $this->find($reference);
        if ($booking === null) {
            throw new \RuntimeException('Booking disappeared after an update.');
        }

        return $booking;
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
