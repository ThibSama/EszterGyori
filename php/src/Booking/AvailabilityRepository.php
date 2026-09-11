<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/**
 * Canonical persistence for weekly rules, replacing date exceptions and
 * (ESZ-152) the additive planning constraints beside them.
 */
final class AvailabilityRepository
{
    private const REVISION_SETTING_KEY = 'availability.revision';

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
        private readonly BookingSerializationLock $serialization,
    ) {
    }

    /**
     * Atomically replaces the complete weekly configuration.
     *
     * @param list<WeeklyAvailabilityRule> $rules
     */
    public function replaceWeeklyRules(int $expectedRevision, array $rules): void
    {
        $this->replaceWeeklyRulesWithRevision($rules, $expectedRevision);
    }

    /**
     * ESZ-151: `$timeRules`, when given, replaces the stored booking-time
     * rules in the same transaction, under the same revision and the same
     * serialization boundary — it changes bookability exactly the way the
     * week does. Null leaves the stored rules untouched.
     *
     * The returned weekly rules and booking-time rules are read inside the
     * same transaction that produces the returned revision, so a caller
     * echoing them never describes a later save's state under this revision.
     *
     * @param list<WeeklyAvailabilityRule> $rules
     * @return array{
     *     revision: int,
     *     weeklyRules: list<WeeklyAvailabilityRule>,
     *     timeRules: BookingTimeRules,
     * }
     */
    public function replaceWeeklyRulesWithRevision(
        array $rules,
        int $expectedRevision,
        ?BookingTimeRules $timeRules = null,
    ): array {
        $this->assertWeeklyRules($rules);

        usort($rules, self::compareRules(...));
        $stored = $this->mutate($expectedRevision, function () use ($rules, $timeRules): array {
            $now = $this->clock->nowIso();
            if ($timeRules !== null) {
                $this->database->run(
                    'INSERT INTO system_settings (setting_key, value_json, created_at, updated_at)'
                    . ' VALUES (:key, :value, :created, :updated) AS incoming'
                    . ' ON DUPLICATE KEY UPDATE value_json = incoming.value_json, updated_at = incoming.updated_at',
                    [
                        'key' => $this->contract->timeRulesSettingKey,
                        'value' => (string) json_encode($timeRules->payload(), JSON_THROW_ON_ERROR),
                        'created' => $now,
                        'updated' => $now,
                    ],
                );
            }

            $this->database->run('DELETE FROM availability_rules');

            foreach ($rules as $rule) {
                $this->database->run(
                    'INSERT INTO availability_rules'
                    . ' (weekday_iso, start_local, end_local, valid_from, valid_until, fold_utc_offset,'
                    . ' is_active, created_at, updated_at)'
                    . ' VALUES (:weekday, :start, :end, :valid_from, :valid_until, :fold, :active,'
                    . ' :created, :updated)',
                    [
                        'weekday' => $rule->weekdayIso,
                        'start' => $rule->window->startLocal,
                        'end' => $rule->window->endLocal,
                        'valid_from' => $rule->validFrom,
                        'valid_until' => $rule->validUntil,
                        'fold' => $rule->window->foldUtcOffset,
                        'active' => $rule->isActive ? 1 : 0,
                        'created' => $now,
                        'updated' => $now,
                    ],
                );
            }

            return [
                'weeklyRules' => $this->weeklyRules(),
                // Read here, not after commit: with `$timeRules` null this is
                // the untouched stored value, still under this revision's lock.
                'timeRules' => $timeRules ?? $this->bookingTimeRules(),
            ];
        });

        return [
            'revision' => $stored['revision'],
            'weeklyRules' => $stored['value']['weeklyRules'],
            'timeRules' => $stored['value']['timeRules'],
        ];
    }

    /**
     * Reads rules, exceptions, the booking-time rules and their shared revision
     * from one repeatable-read snapshot, so the token can never describe a
     * different schedule.
     *
     * @return array{
     *     revision: int,
     *     weeklyRules: list<WeeklyAvailabilityRule>,
     *     exceptions: list<AvailabilityException>,
     *     timeRules: BookingTimeRules,
     *     constraints: list<PlanningConstraint>,
     * }
     */
    public function stateBetween(string $fromDate, string $untilDate): array
    {
        self::dateRange($fromDate, $untilDate);
        $read = fn (): array => [
            'revision' => $this->revision(),
            'weeklyRules' => $this->weeklyRules(),
            'exceptions' => $this->exceptionsBetween($fromDate, $untilDate),
            'timeRules' => $this->bookingTimeRules(),
            'constraints' => $this->constraintsBetween($fromDate, $untilDate),
        ];

        return $this->database->inTransaction()
            ? $read()
            : $this->database->consistentSnapshot($read);
    }

    public function revision(): int
    {
        $row = $this->database->fetchOne(
            'SELECT value_json FROM system_settings WHERE setting_key = :key',
            ['key' => self::REVISION_SETTING_KEY],
        );

        return $row === null ? 0 : self::revisionFromRow($row);
    }

    /**
     * ESZ-151 — the stored booking-time rules, or the contract defaults while
     * no row exists. Every slot computation and every revalidation reads this
     * same row; nothing caches it across requests.
     */
    public function bookingTimeRules(): BookingTimeRules
    {
        $row = $this->database->fetchOne(
            'SELECT value_json FROM system_settings WHERE setting_key = :key',
            ['key' => $this->contract->timeRulesSettingKey],
        );
        if ($row === null) {
            return BookingTimeRules::defaults();
        }

        $json = $row['value_json'] ?? null;
        if (!\is_string($json)) {
            throw new \RuntimeException('Booking time rules setting is malformed.');
        }
        /** @var mixed $decoded */
        $decoded = json_decode($json, true, 2, JSON_THROW_ON_ERROR);
        if (!\is_array($decoded)) {
            throw new \RuntimeException('Booking time rules setting is malformed.');
        }

        return BookingTimeRules::fromStored($decoded, $this->contract);
    }

    /** @return list<WeeklyAvailabilityRule> */
    public function weeklyRules(): array
    {
        return array_map(
            $this->weeklyRuleFromRow(...),
            $this->database->fetchAll(
                'SELECT id, weekday_iso, start_local, end_local, valid_from, valid_until,'
                . ' fold_utc_offset, is_active FROM availability_rules'
                . ' ORDER BY weekday_iso, start_local, valid_from, id',
            ),
        );
    }

    /** @param list<AvailabilityWindow> $windows */
    public function putOpenException(
        int $expectedRevision,
        string $localDate,
        array $windows,
        ?string $note = null,
    ): AvailabilityException {
        if ($windows === []) {
            throw new BookingValidationException('exceptionWindows', 'Open exception requires at least one window.');
        }

        return $this->putOpenExceptionWithRevision($localDate, $windows, $note, $expectedRevision)['value'];
    }

    /**
     * @param list<AvailabilityWindow> $windows
     * @return array{revision: int, value: AvailabilityException}
     */
    public function putOpenExceptionWithRevision(
        string $localDate,
        array $windows,
        ?string $note,
        int $expectedRevision,
    ): array {
        if ($windows === []) {
            throw new BookingValidationException('exceptionWindows', 'Open exception requires at least one window.');
        }

        return $this->putException($localDate, 'open', $windows, $note, $expectedRevision);
    }

    public function putClosedException(
        int $expectedRevision,
        string $localDate,
        ?string $note = null,
    ): AvailabilityException {
        return $this->putClosedExceptionWithRevision($localDate, $note, $expectedRevision)['value'];
    }

    /** @return array{revision: int, value: AvailabilityException} */
    public function putClosedExceptionWithRevision(string $localDate, ?string $note, int $expectedRevision): array
    {
        return $this->putException($localDate, 'closed', [], $note, $expectedRevision);
    }

    /**
     * Removes the replacing exception for one local date, restoring the weekly
     * rules for it.
     *
     * There is nothing to un-merge, because nothing was ever merged: an
     * exception *replaces* the weekly result for its date, so deleting the row
     * is the whole operation. The child windows go with it through the foreign
     * key's ON DELETE CASCADE rather than through a second statement that could
     * fail on its own.
     *
     * Returns false when there was no exception, which is not an error: asking
     * for a date to follow the weekly rules when it already does is a request
     * that is already satisfied.
     */
    public function deleteException(int $expectedRevision, string $localDate): bool
    {
        return $this->deleteExceptionWithRevision($localDate, $expectedRevision)['value'];
    }

    /** @return array{revision: int, value: bool} */
    public function deleteExceptionWithRevision(string $localDate, int $expectedRevision): array
    {
        self::date($localDate, 'localDate');

        return $this->mutate($expectedRevision, function () use ($localDate): bool {
            $deleted = $this->database->run(
                'DELETE FROM availability_exceptions WHERE exception_date = :date',
                ['date' => $localDate],
            )->rowCount() > 0;

            return $deleted;
        });
    }

    public function findException(string $localDate): ?AvailabilityException
    {
        self::date($localDate, 'localDate');
        $row = $this->database->fetchOne(
            'SELECT id, exception_date, exception_kind, start_local, end_local, fold_utc_offset, note'
            . ' FROM availability_exceptions WHERE exception_date = :date',
            ['date' => $localDate],
        );

        return $row === null ? null : $this->exceptionFromRow($row);
    }

    /** @return list<AvailabilityException> */
    public function exceptionsBetween(string $fromDate, string $untilDate): array
    {
        self::dateRange($fromDate, $untilDate);
        $exceptions = [];
        foreach (
            $this->database->fetchAll(
                'SELECT id, exception_date, exception_kind, start_local, end_local, fold_utc_offset, note'
                . ' FROM availability_exceptions WHERE exception_date BETWEEN :from_date AND :until_date'
                . ' ORDER BY exception_date',
                ['from_date' => $fromDate, 'until_date' => $untilDate],
            ) as $row
        ) {
            $exceptions[] = $this->exceptionFromRow($row);
        }

        return $exceptions;
    }

    /**
     * ESZ-152 — every constraint whose inclusive date range touches the
     * requested local window, in date order. Bounded by the caller's window,
     * exactly like the exceptions read beside it.
     *
     * @return list<PlanningConstraint>
     */
    public function constraintsBetween(string $fromDate, string $untilDate): array
    {
        self::dateRange($fromDate, $untilDate);

        return array_map(
            $this->constraintFromRow(...),
            $this->database->fetchAll(
                'SELECT id, constraint_kind, start_date, end_date, start_local, end_local, fold_utc_offset, reason'
                . ' FROM availability_constraints'
                . ' WHERE start_date <= :until_date AND end_date >= :from_date'
                . ' ORDER BY start_date, start_local, id',
                ['from_date' => $fromDate, 'until_date' => $untilDate],
            ),
        );
    }

    public function findConstraint(int $id): ?PlanningConstraint
    {
        $row = $this->database->fetchOne(
            'SELECT id, constraint_kind, start_date, end_date, start_local, end_local, fold_utc_offset, reason'
            . ' FROM availability_constraints WHERE id = :id',
            ['id' => $id],
        );

        return $row === null ? null : $this->constraintFromRow($row);
    }

    /**
     * ESZ-152 — stores one constraint: an insert when `$constraint->id` is 0,
     * otherwise a full replacement of the row with that id (404 when there is
     * none). The timed boundaries are converted with the Europe/Paris rules
     * before anything is written, exactly as for a date exception. Under the
     * serialization boundary and the availability revision like every other
     * bookability write; no booking row is read or touched.
     *
     * @return array{revision: int, value: PlanningConstraint}
     */
    public function putConstraintWithRevision(PlanningConstraint $constraint, int $expectedRevision): array
    {
        // Refuse a spring gap or an unresolved autumn fold before the
        // transaction — for a pause too, so what is drawn is a real interval.
        if ($constraint->window !== null) {
            foreach ([$constraint->window->startLocal, $constraint->window->endLocal] as $boundary) {
                $this->time->localToUtcWithFoldOffset(
                    $constraint->startDate . ' ' . $boundary,
                    $constraint->window->foldUtcOffset,
                );
            }
        }

        return $this->mutate($expectedRevision, function () use ($constraint): PlanningConstraint {
            $now = $this->clock->nowIso();
            $values = [
                'kind' => $constraint->kind,
                'enforcement' => $constraint->enforcement,
                'start_date' => $constraint->startDate,
                'end_date' => $constraint->endDate,
                'start' => $constraint->window?->startLocal,
                'end' => $constraint->window?->endLocal,
                'fold' => $constraint->window?->foldUtcOffset,
                'reason' => $constraint->reason,
                'updated' => $now,
            ];

            if ($constraint->id === 0) {
                $this->database->run(
                    'INSERT INTO availability_constraints'
                    . ' (constraint_kind, enforcement, start_date, end_date, start_local, end_local,'
                    . ' fold_utc_offset, reason, created_at, updated_at)'
                    . ' VALUES (:kind, :enforcement, :start_date, :end_date, :start, :end, :fold, :reason,'
                    . ' :created, :updated)',
                    $values + ['created' => $now],
                );
                $id = (int) $this->database->pdo()->lastInsertId();
            } else {
                $updated = $this->database->run(
                    'UPDATE availability_constraints SET constraint_kind = :kind, enforcement = :enforcement,'
                    . ' start_date = :start_date, end_date = :end_date, start_local = :start, end_local = :end,'
                    . ' fold_utc_offset = :fold, reason = :reason, updated_at = :updated WHERE id = :id',
                    $values + ['id' => $constraint->id],
                )->rowCount();
                if ($updated === 0 && $this->findConstraint($constraint->id) === null) {
                    throw new PlanningConstraintNotFoundException($constraint->id);
                }
                $id = $constraint->id;
            }

            $stored = $this->findConstraint($id);
            if ($stored === null) {
                throw new \RuntimeException('Planning constraint disappeared after being stored.');
            }

            return $stored;
        });
    }

    /**
     * ESZ-152 — removes one constraint. Deleting the row is the whole
     * operation: nothing was merged into the schedule, and no booking is
     * touched. 404 when there is no such row.
     *
     * @return array{revision: int, value: bool}
     */
    public function deleteConstraintWithRevision(int $id, int $expectedRevision): array
    {
        return $this->mutate($expectedRevision, function () use ($id): bool {
            $deleted = $this->database->run(
                'DELETE FROM availability_constraints WHERE id = :id',
                ['id' => $id],
            )->rowCount() > 0;
            if (!$deleted) {
                throw new PlanningConstraintNotFoundException($id);
            }

            return true;
        });
    }

    /**
     * @param list<AvailabilityWindow> $windows
     * @return array{revision: int, value: AvailabilityException}
     */
    private function putException(
        string $localDate,
        string $kind,
        array $windows,
        ?string $note,
        int $expectedRevision,
    ): array {
        self::date($localDate, 'localDate');
        $note = self::optional($note);
        if ($note !== null && mb_strlen($note) > 255) {
            throw new BookingValidationException('exceptionNote', 'Exception note is too long.');
        }

        $windows = $this->orderedWindows($windows);
        foreach ($windows as $window) {
            $this->time->localToUtcWithFoldOffset(
                $localDate . ' ' . $window->startLocal,
                $window->foldUtcOffset,
            );
            $this->time->localToUtcWithFoldOffset(
                $localDate . ' ' . $window->endLocal,
                $window->foldUtcOffset,
            );
        }

        return $this->mutate(
            $expectedRevision,
            function () use ($localDate, $kind, $windows, $note): AvailabilityException {
                $first = $windows[0] ?? null;
                $now = $this->clock->nowIso();
                $this->database->run(
                    'INSERT INTO availability_exceptions'
                    . ' (exception_date, exception_kind, start_local, end_local, fold_utc_offset, note,'
                    . ' created_at, updated_at)'
                    . ' VALUES (:date, :kind, :start, :end, :fold, :note, :created, :updated)'
                    . ' ON DUPLICATE KEY UPDATE exception_kind = VALUES(exception_kind),'
                    . ' start_local = VALUES(start_local), end_local = VALUES(end_local),'
                    . ' fold_utc_offset = VALUES(fold_utc_offset), note = VALUES(note),'
                    . ' updated_at = VALUES(updated_at)',
                    [
                    'date' => $localDate,
                    'kind' => $kind,
                    'start' => $first?->startLocal,
                    'end' => $first?->endLocal,
                    'fold' => $first?->foldUtcOffset,
                    'note' => $note,
                    'created' => $now,
                    'updated' => $now,
                    ],
                );

                $parent = $this->database->fetchOne(
                    'SELECT id FROM availability_exceptions WHERE exception_date = :date FOR UPDATE',
                    ['date' => $localDate],
                );
                $id = $parent['id'] ?? null;
                if (!\is_int($id)) {
                    throw new \RuntimeException('Availability exception disappeared while being stored.');
                }

                $this->database->run(
                    'DELETE FROM availability_exception_windows WHERE exception_id = :id',
                    ['id' => $id],
                );
                foreach (array_slice($windows, 1) as $index => $window) {
                    $this->database->run(
                        'INSERT INTO availability_exception_windows'
                        . ' (exception_id, position, start_local, end_local, fold_utc_offset)'
                        . ' VALUES (:exception, :position, :start, :end, :fold)',
                        [
                        'exception' => $id,
                        'position' => $index + 2,
                        'start' => $window->startLocal,
                        'end' => $window->endLocal,
                        'fold' => $window->foldUtcOffset,
                        ],
                    );
                }

                $stored = $this->findException($localDate);
                if ($stored === null) {
                    throw new \RuntimeException('Availability exception disappeared after being stored.');
                }

                return $stored;
            },
        );
    }

    /**
     * Every availability write funnels through here, and every one takes the
     * booking serialization boundary first (ESZ-146).
     *
     * The optimistic-concurrency revision lock alone cannot serialize against
     * booking create/move, which never read the revision: an in-flight create
     * could validate a slot from before this mutation committed and confirm it
     * anyway. Taking `booking_resource_locks.primary` inside the same
     * transaction and before the revision row lock makes the first acquirer
     * the linearization point for both sides, so a create/move that starts
     * behind a committed weekly replacement or date exception re-reads the new
     * schedule and can confirm only a still-valid slot. ESZ-137 is preserved:
     * a stale `expectedRevision` still fails deterministically, writing
     * nothing, after the boundary has been acquired.
     *
     * @template T
     * @param \Closure(): T $change
     * @return array{revision: int, value: T}
     */
    private function mutate(int $expectedRevision, \Closure $change): array
    {
        if ($expectedRevision < 0) {
            throw new BookingValidationException('expectedRevision', 'Availability revision must be non-negative.');
        }

        return $this->database->transactional(function () use ($expectedRevision, $change): array {
            $this->serialization->acquire();
            $now = $this->clock->nowIso();
            $this->database->run(
                'INSERT IGNORE INTO system_settings (setting_key, value_json, created_at, updated_at)'
                . ' VALUES (:key, :value, :created, :updated)',
                [
                    'key' => self::REVISION_SETTING_KEY,
                    'value' => '{"revision":0}',
                    'created' => $now,
                    'updated' => $now,
                ],
            );
            $row = $this->database->fetchOne(
                'SELECT value_json FROM system_settings WHERE setting_key = :key FOR UPDATE',
                ['key' => self::REVISION_SETTING_KEY],
            );
            if ($row === null) {
                throw new \RuntimeException('Availability revision setting disappeared while being locked.');
            }

            $currentRevision = self::revisionFromRow($row);
            if ($currentRevision !== $expectedRevision) {
                throw new AvailabilityRevisionConflictException($expectedRevision, $currentRevision);
            }

            $value = $change();
            $nextRevision = $currentRevision + 1;
            $this->database->run(
                'UPDATE system_settings SET value_json = :value, updated_at = :updated WHERE setting_key = :key',
                [
                    'key' => self::REVISION_SETTING_KEY,
                    'value' => (string) json_encode(['revision' => $nextRevision], JSON_THROW_ON_ERROR),
                    'updated' => $now,
                ],
            );

            return ['revision' => $nextRevision, 'value' => $value];
        });
    }

    /** @param array<string, mixed> $row */
    private static function revisionFromRow(array $row): int
    {
        $json = $row['value_json'] ?? null;
        if (!\is_string($json)) {
            throw new \RuntimeException('Availability revision setting is malformed.');
        }

        /** @var mixed $decoded */
        $decoded = json_decode($json, true, 2, JSON_THROW_ON_ERROR);
        $revision = \is_array($decoded) ? ($decoded['revision'] ?? null) : null;
        if (!\is_int($revision) || $revision < 0) {
            throw new \RuntimeException('Availability revision setting is malformed.');
        }

        return $revision;
    }

    /** @param list<WeeklyAvailabilityRule> $rules */
    private function assertWeeklyRules(array $rules): void
    {
        foreach ($rules as $index => $left) {
            if (!$left instanceof WeeklyAvailabilityRule) {
                throw new BookingValidationException('weeklyRules', 'Weekly rule list is malformed.');
            }
            foreach (array_slice($rules, $index + 1) as $right) {
                if (
                    $left->weekdayIso === $right->weekdayIso
                    && self::dateRangesOverlap($left, $right)
                    && self::windowsOverlap($left->window, $right->window)
                ) {
                    throw new BookingValidationException(
                        'weeklyRules',
                        'Weekly windows overlap for an intersecting validity range.',
                    );
                }
            }
        }
    }

    /**
     * @param list<AvailabilityWindow> $windows
     * @return list<AvailabilityWindow>
     */
    private function orderedWindows(array $windows): array
    {
        foreach ($windows as $window) {
            if (!$window instanceof AvailabilityWindow) {
                throw new BookingValidationException('windows', 'Availability window list is malformed.');
            }
        }
        usort($windows, static fn (AvailabilityWindow $a, AvailabilityWindow $b): int =>
            [$a->startLocal, $a->endLocal] <=> [$b->startLocal, $b->endLocal]);

        foreach ($windows as $index => $window) {
            $next = $windows[$index + 1] ?? null;
            if ($next !== null && self::windowsOverlap($window, $next)) {
                throw new BookingValidationException('windows', 'Availability windows overlap.');
            }
        }

        return $windows;
    }

    /** @param array<string, mixed> $row */
    private function weeklyRuleFromRow(array $row): WeeklyAvailabilityRule
    {
        return new WeeklyAvailabilityRule(
            self::integer($row, 'id'),
            self::integer($row, 'weekday_iso'),
            AvailabilityWindow::create(
                self::string($row, 'start_local'),
                self::string($row, 'end_local'),
                self::nullableString($row, 'fold_utc_offset'),
                $this->contract,
            ),
            self::nullableString($row, 'valid_from'),
            self::nullableString($row, 'valid_until'),
            self::integer($row, 'is_active') === 1,
        );
    }

    /** @param array<string, mixed> $row */
    private function exceptionFromRow(array $row): AvailabilityException
    {
        $id = self::integer($row, 'id');
        $kind = self::string($row, 'exception_kind');
        $windows = [];
        if ($kind === 'open') {
            $windows[] = AvailabilityWindow::create(
                self::string($row, 'start_local'),
                self::string($row, 'end_local'),
                self::nullableString($row, 'fold_utc_offset'),
                $this->contract,
            );
            foreach (
                $this->database->fetchAll(
                    'SELECT start_local, end_local, fold_utc_offset'
                    . ' FROM availability_exception_windows WHERE exception_id = :id ORDER BY position',
                    ['id' => $id],
                ) as $window
            ) {
                $windows[] = AvailabilityWindow::create(
                    self::string($window, 'start_local'),
                    self::string($window, 'end_local'),
                    self::nullableString($window, 'fold_utc_offset'),
                    $this->contract,
                );
            }
        }

        return new AvailabilityException(
            $id,
            self::string($row, 'exception_date'),
            $kind,
            $windows,
            self::nullableString($row, 'note'),
        );
    }

    /** @param array<string, mixed> $row */
    private function constraintFromRow(array $row): PlanningConstraint
    {
        $start = self::nullableString($row, 'start_local');
        $end = self::nullableString($row, 'end_local');

        return PlanningConstraint::create(
            self::integer($row, 'id'),
            self::string($row, 'constraint_kind'),
            self::string($row, 'start_date'),
            self::string($row, 'end_date'),
            $start === null ? null : substr($start, 0, 5),
            $end === null ? null : substr($end, 0, 5),
            self::nullableString($row, 'fold_utc_offset'),
            self::nullableString($row, 'reason'),
            $this->contract,
        );
    }

    private static function compareRules(WeeklyAvailabilityRule $a, WeeklyAvailabilityRule $b): int
    {
        return [$a->weekdayIso, $a->window->startLocal, $a->validFrom ?? '']
            <=> [$b->weekdayIso, $b->window->startLocal, $b->validFrom ?? ''];
    }

    private static function dateRangesOverlap(WeeklyAvailabilityRule $a, WeeklyAvailabilityRule $b): bool
    {
        $aStart = $a->validFrom ?? '0000-01-01';
        $aEnd = $a->validUntil ?? '9999-12-31';
        $bStart = $b->validFrom ?? '0000-01-01';
        $bEnd = $b->validUntil ?? '9999-12-31';

        return $aStart <= $bEnd && $bStart <= $aEnd;
    }

    private static function windowsOverlap(AvailabilityWindow $a, AvailabilityWindow $b): bool
    {
        return $a->startLocal < $b->endLocal && $b->startLocal < $a->endLocal;
    }

    private static function dateRange(string $from, string $until): void
    {
        self::date($from, 'fromDate');
        self::date($until, 'untilDate');
        if ($until < $from) {
            throw new BookingValidationException('untilDate', 'Date range is inverted.');
        }
    }

    private static function date(string $value, string $field): void
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d') !== $value) {
            throw new BookingValidationException($field, 'Date must be a real YYYY-MM-DD value.');
        }
    }

    /** @param array<string, mixed> $row */
    private static function integer(array $row, string $field): int
    {
        $value = $row[$field] ?? null;
        if (!\is_int($value)) {
            throw new \RuntimeException("Availability row has no integer {$field}.");
        }

        return $value;
    }

    /** @param array<string, mixed> $row */
    private static function string(array $row, string $field): string
    {
        $value = $row[$field] ?? null;
        if (!\is_string($value)) {
            throw new \RuntimeException("Availability row has no string {$field}.");
        }

        return $value;
    }

    /** @param array<string, mixed> $row */
    private static function nullableString(array $row, string $field): ?string
    {
        $value = $row[$field] ?? null;
        if ($value !== null && !\is_string($value)) {
            throw new \RuntimeException("Availability row has malformed {$field}.");
        }

        return $value;
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
