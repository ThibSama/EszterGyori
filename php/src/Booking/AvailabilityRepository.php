<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/** Canonical persistence for weekly rules and replacing date exceptions. */
final class AvailabilityRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
    ) {
    }

    /**
     * Atomically replaces the complete weekly configuration.
     *
     * @param list<WeeklyAvailabilityRule> $rules
     */
    public function replaceWeeklyRules(array $rules): void
    {
        $this->assertWeeklyRules($rules);

        usort($rules, self::compareRules(...));
        $this->database->transactional(function () use ($rules): void {
            $this->database->fetchAll('SELECT id FROM availability_rules FOR UPDATE');
            $this->database->run('DELETE FROM availability_rules');
            $now = $this->clock->nowIso();

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
        });
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
    public function putOpenException(string $localDate, array $windows, ?string $note = null): AvailabilityException
    {
        if ($windows === []) {
            throw new BookingValidationException('exceptionWindows', 'Open exception requires at least one window.');
        }

        return $this->putException($localDate, 'open', $windows, $note);
    }

    public function putClosedException(string $localDate, ?string $note = null): AvailabilityException
    {
        return $this->putException($localDate, 'closed', [], $note);
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
    public function deleteException(string $localDate): bool
    {
        self::date($localDate, 'localDate');

        return $this->database->transactional(function () use ($localDate): bool {
            $row = $this->database->fetchOne(
                'SELECT id FROM availability_exceptions WHERE exception_date = :date FOR UPDATE',
                ['date' => $localDate],
            );
            if ($row === null) {
                return false;
            }

            $this->database->run(
                'DELETE FROM availability_exceptions WHERE exception_date = :date',
                ['date' => $localDate],
            );

            return true;
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
     * @param list<AvailabilityWindow> $windows
     */
    private function putException(
        string $localDate,
        string $kind,
        array $windows,
        ?string $note,
    ): AvailabilityException {
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

        return $this->database->transactional(
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
