<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Support\IsoTimestamp;

/**
 * Availability administration: the stored-schedule reads and the replacing
 * weekly/date-exception writes of the editor surface (ESZ-106).
 *
 * Every write constructs (and therefore validates) the full submitted shape
 * before the repository is called; the repository then performs the
 * delete-and-reinsert (or exception put/delete) inside the transaction that
 * holds the global availability revision, so a stale `expectedRevision` is
 * refused and no ordering of failures can leave half a schedule behind. The
 * responses are read back from storage rather than echoed from the request.
 */
final class AvailabilityAdministration
{
    /**
     * The widest window the availability editor may ask for in one read.
     *
     * Mirrors `ADMIN_AVAILABILITY_MAX_RANGE_DAYS` in the frozen HTTP contract,
     * where it is also recorded in `booking.availabilityAdministration`. It is a
     * relation between two request fields, so JSON Schema cannot express it and
     * the server has to be the one that says no.
     */
    private const MAX_AVAILABILITY_RANGE_DAYS = 400;

    public function __construct(
        private readonly BookingDomainContract $contract,
        private readonly AvailabilityRepository $availabilityRepository,
        private readonly BookingTimePolicy $time,
        private readonly BookingRepository $bookings,
    ) {
    }

    /**
     * ESZ-063/064 — the stored schedule, read back.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminAvailability(array $request): array
    {
        $fromDate = BookingRequestFields::requiredString($request, 'fromDate');
        $untilDate = BookingRequestFields::requiredString($request, 'untilDate');
        $from = BookingRequestFields::date($fromDate, 'fromDate');
        $until = BookingRequestFields::date($untilDate, 'untilDate');
        $days = (int) $from->diff($until)->format('%r%a') + 1;
        if ($days < 1 || $days > self::MAX_AVAILABILITY_RANGE_DAYS) {
            throw new BookingValidationException('untilDate', 'Availability range is invalid or too large.');
        }

        $state = $this->availabilityRepository->stateBetween($fromDate, $untilDate);

        return [
            'timezone' => $this->contract->timezone,
            'fromDate' => $fromDate,
            'untilDate' => $untilDate,
            'revision' => $state['revision'],
            'weeklyRules' => array_map(
                $this->weeklyRulePayload(...),
                $state['weeklyRules'],
            ),
            'exceptions' => array_map(
                $this->exceptionPayload(...),
                $state['exceptions'],
            ),
            'bookingTimeRules' => $state['timeRules']->payload(),
            'constraints' => array_map($this->constraintPayload(...), $state['constraints']),
        ];
    }

    /**
     * ESZ-152 — pauses, unavailability, closures and leave.
     *
     * `create` and `update` construct (validate) the whole submitted shape
     * first, then the repository stores it under the availability revision
     * and the serialization boundary. A strict constraint is *allowed* to
     * overlap confirmed appointments: after the write, those appointments
     * are read back as `conflicts` so the operator is warned, and none of
     * them is touched — no move, no cancellation, no history event. A
     * flexible pause reports no conflicts because it prohibits nothing.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutateAvailabilityConstraint(array $request): array
    {
        $action = BookingRequestFields::requiredString($request, 'action');
        $expectedRevision = BookingRequestFields::requiredInt($request, 'expectedRevision');

        if ($action === 'remove') {
            $stored = $this->availabilityRepository->deleteConstraintWithRevision(
                BookingRequestFields::requiredInt($request, 'id'),
                $expectedRevision,
            );

            return ['revision' => $stored['revision'], 'constraint' => null, 'conflicts' => []];
        }

        $id = match ($action) {
            'create' => 0,
            'update' => BookingRequestFields::requiredInt($request, 'id'),
            default => throw new BookingValidationException('action', 'Unknown planning constraint action.'),
        };
        if ($action === 'update' && $id < 1) {
            throw new BookingValidationException('id', 'Planning constraint id must be positive.');
        }

        $constraint = PlanningConstraint::create(
            $id,
            BookingRequestFields::requiredString($request, 'kind'),
            BookingRequestFields::requiredString($request, 'startDate'),
            BookingRequestFields::requiredString($request, 'endDate'),
            BookingRequestFields::nullableString($request, 'startLocal'),
            BookingRequestFields::nullableString($request, 'endLocal'),
            BookingRequestFields::nullableString($request, 'foldUtcOffset'),
            BookingRequestFields::nullableString($request, 'reason'),
            $this->contract,
        );
        $stored = $this->availabilityRepository->putConstraintWithRevision($constraint, $expectedRevision);

        return [
            'revision' => $stored['revision'],
            'constraint' => $this->constraintPayload($stored['value']),
            'conflicts' => $this->conflicts($stored['value']),
        ];
    }

    /**
     * The confirmed appointments a strict constraint overlaps, as stored now.
     * Informational: a warning, never a precondition and never a write.
     *
     * @return list<array<string, mixed>>
     */
    private function conflicts(PlanningConstraint $constraint): array
    {
        $blocked = $constraint->blockingInterval($this->time);
        if ($blocked === null) {
            return [];
        }

        return array_map(
            static fn (Booking $booking): array => [
                'reference' => $booking->reference,
                'customerName' => $booking->customerName,
                'startsAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->startsAtUtc)),
                'endsAtUtc' => IsoTimestamp::format(BookingRequestFields::databaseInstant($booking->endsAtUtc)),
            ],
            $this->bookings->confirmedOverlapping($blocked->startsAtUtc, $blocked->endsAtUtc),
        );
    }

    /** @return array<string, mixed> */
    private function constraintPayload(PlanningConstraint $constraint): array
    {
        return [
            'id' => $constraint->id,
            'kind' => $constraint->kind,
            'enforcement' => $constraint->enforcement,
            'startDate' => $constraint->startDate,
            'endDate' => $constraint->endDate,
            'startLocal' => $constraint->window === null
                ? null
                : self::minutePrecision($constraint->window->startLocal),
            'endLocal' => $constraint->window === null ? null : self::minutePrecision($constraint->window->endLocal),
            'foldUtcOffset' => $constraint->window?->foldUtcOffset,
            'reason' => $constraint->reason,
        ];
    }

    /**
     * ESZ-063 — replaces the complete weekly schedule.
     *
     * Every submitted rule is constructed, and therefore validated, before the
     * repository is called at all: a malformed weekday, an inverted window or an
     * impossible validity range raises here, with nothing written. The repository
     * then re-checks the set for overlaps and performs the delete-and-reinsert
     * inside the transaction holding the global availability revision, so there
     * is no ordering of failures that can leave half a week behind.
     *
     * The response is read back from storage rather than echoed from the request.
     * That is what lets the editor adopt server state instead of its own: the ids
     * are new, and the ordering is the repository's.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminReplaceWeeklyAvailability(array $request): array
    {
        $expectedRevision = BookingRequestFields::requiredInt($request, 'expectedRevision');
        $submitted = $request['rules'] ?? null;
        if (!\is_array($submitted)) {
            throw new BookingValidationException('rules', 'Weekly rule list is required.');
        }

        $rules = [];
        foreach ($submitted as $row) {
            if (!\is_array($row)) {
                throw new BookingValidationException('rules', 'Weekly rule list is malformed.');
            }

            /** @var array<string, mixed> $row */
            $rules[] = new WeeklyAvailabilityRule(
                // The id is assigned by the insert. Nothing the caller sends can
                // name a row, because the whole set is being replaced.
                0,
                BookingRequestFields::requiredInt($row, 'weekdayIso'),
                AvailabilityWindow::create(
                    BookingRequestFields::requiredString($row, 'startLocal'),
                    BookingRequestFields::requiredString($row, 'endLocal'),
                    BookingRequestFields::nullableString($row, 'foldUtcOffset'),
                    $this->contract,
                ),
                BookingRequestFields::nullableString($row, 'validFrom'),
                BookingRequestFields::nullableString($row, 'validUntil'),
                BookingRequestFields::requiredBool($row, 'isActive'),
            );
        }

        // ESZ-151: the booking-time rules ride on the same PUT, and are
        // constructed (validated) here like every rule row — before the
        // repository writes anything, under the same revision.
        $stored = $this->availabilityRepository->replaceWeeklyRulesWithRevision(
            $rules,
            $expectedRevision,
            $this->submittedTimeRules($request),
        );

        // Every field below comes from the one transaction that produced
        // `revision`; a reread here could describe a concurrent later save.
        return [
            'timezone' => $this->contract->timezone,
            'revision' => $stored['revision'],
            'weeklyRules' => array_map(
                $this->weeklyRulePayload(...),
                $stored['weeklyRules'],
            ),
            'bookingTimeRules' => $stored['timeRules']->payload(),
        ];
    }

    /**
     * Absent means "leave the stored rules as they are"; present replaces all
     * three values.
     *
     * @param array<string, mixed> $request
     */
    private function submittedTimeRules(array $request): ?BookingTimeRules
    {
        $submitted = $request['bookingTimeRules'] ?? null;
        if ($submitted === null) {
            return null;
        }
        if (!\is_array($submitted)) {
            throw new BookingValidationException('bookingTimeRules', 'Booking time rules are malformed.');
        }

        /** @var array<string, mixed> $submitted */
        return BookingTimeRules::create(
            BookingRequestFields::requiredInt($submitted, 'minimumLeadMinutes'),
            BookingRequestFields::nullableString($submitted, 'preferredFinishLocal'),
            BookingRequestFields::requiredInt($submitted, 'maxOverrunMinutes'),
            $this->contract,
        );
    }

    /**
     * ESZ-064 — closures, exceptional openings and removals.
     *
     * `close` and `open` both go through the repository's replacing put, which
     * converts every window boundary with the Europe/Paris IANA rules before
     * storing it: a spring-forward gap is refused and an autumn overlap needs the
     * explicit fold offset. `remove` deletes the row, and deleting it is the
     * whole of restoring the weekly behaviour, because the two were never merged.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutateAvailabilityException(array $request): array
    {
        $action = BookingRequestFields::requiredString($request, 'action');
        $localDate = BookingRequestFields::requiredString($request, 'localDate');
        $expectedRevision = BookingRequestFields::requiredInt($request, 'expectedRevision');

        if ($action === 'remove') {
            $stored = $this->availabilityRepository->deleteExceptionWithRevision($localDate, $expectedRevision);

            return ['revision' => $stored['revision'], 'exception' => null];
        }

        $stored = match ($action) {
            'close' => $this->availabilityRepository->putClosedExceptionWithRevision(
                $localDate,
                BookingRequestFields::nullableString($request, 'note'),
                $expectedRevision,
            ),
            'open' => $this->availabilityRepository->putOpenExceptionWithRevision(
                $localDate,
                $this->submittedWindows($request),
                BookingRequestFields::nullableString($request, 'note'),
                $expectedRevision,
            ),
            default => throw new BookingValidationException(
                'action',
                'Unknown availability exception action.',
            ),
        };

        return [
            'revision' => $stored['revision'],
            'exception' => $this->exceptionPayload($stored['value']),
        ];
    }

    /**
     * @param array<string, mixed> $request
     * @return list<AvailabilityWindow>
     */
    private function submittedWindows(array $request): array
    {
        $submitted = $request['windows'] ?? null;
        if (!\is_array($submitted)) {
            throw new BookingValidationException('windows', 'Window list is required.');
        }

        $windows = [];
        foreach ($submitted as $row) {
            if (!\is_array($row)) {
                throw new BookingValidationException('windows', 'Window list is malformed.');
            }

            /** @var array<string, mixed> $row */
            $windows[] = AvailabilityWindow::create(
                BookingRequestFields::requiredString($row, 'startLocal'),
                BookingRequestFields::requiredString($row, 'endLocal'),
                BookingRequestFields::nullableString($row, 'foldUtcOffset'),
                $this->contract,
            );
        }

        return $windows;
    }

    /** @return array<string, mixed> */
    private function weeklyRulePayload(WeeklyAvailabilityRule $rule): array
    {
        return [
            'id' => $rule->id,
            'weekdayIso' => $rule->weekdayIso,
            'startLocal' => self::minutePrecision($rule->window->startLocal),
            'endLocal' => self::minutePrecision($rule->window->endLocal),
            'foldUtcOffset' => $rule->window->foldUtcOffset,
            'validFrom' => $rule->validFrom,
            'validUntil' => $rule->validUntil,
            'isActive' => $rule->isActive,
        ];
    }

    /** @return array<string, mixed> */
    private function exceptionPayload(AvailabilityException $exception): array
    {
        return [
            'id' => $exception->id,
            'localDate' => $exception->localDate,
            'kind' => $exception->kind,
            'windows' => array_map(
                static fn (AvailabilityWindow $window): array => [
                    'startLocal' => self::minutePrecision($window->startLocal),
                    'endLocal' => self::minutePrecision($window->endLocal),
                    'foldUtcOffset' => $window->foldUtcOffset,
                ],
                $exception->windows,
            ),
            'note' => $exception->note,
        ];
    }

    /**
     * Availability is stored at one-minute precision as a MySQL TIME, which reads
     * back as `HH:MM:SS`. The contract's wire format is `HH:MM`, so the seconds —
     * which the domain already guarantees are zero — are dropped here rather than
     * left for each consumer to trim.
     */
    private static function minutePrecision(string $localTime): string
    {
        return substr($localTime, 0, 5);
    }
}
