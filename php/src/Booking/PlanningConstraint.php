<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * ESZ-152 — one planning constraint: a flexible pause, or a strict
 * unavailability, closure or leave.
 *
 * The enforcement is a property of the kind (the domain artifact's
 * `enforcementByKind`) and is carried explicitly, on the row and on the wire,
 * so a preference and a blocker can never be confused by a reader that does
 * not know the kinds. Timed kinds (`pause`, `unavailability`) are one local
 * date with a wall-time window; all-day kinds (`closure`, `leave`) are an
 * inclusive local date range with no window.
 *
 * What a strict constraint *blocks* is decided nowhere here: the
 * {@see SlotEngine} converts it to blocking UTC intervals beside the occupied
 * ones, and a flexible one is never converted at all.
 */
final class PlanningConstraint
{
    public const FLEXIBLE = 'flexible';
    public const STRICT = 'strict';

    private function __construct(
        public readonly int $id,
        public readonly string $kind,
        public readonly string $enforcement,
        public readonly string $startDate,
        public readonly string $endDate,
        public readonly ?AvailabilityWindow $window,
        public readonly ?string $reason,
    ) {
    }

    /**
     * Validates the submitted shape against the domain: a known kind, real
     * dates, a non-inverted range no longer than the bound, a window on a
     * timed kind only, and a reason within the note length. DST validity of
     * the window's boundaries is the repository's, at store time, exactly as
     * for a date exception.
     */
    public static function create(
        int $id,
        string $kind,
        string $startDate,
        string $endDate,
        ?string $startLocal,
        ?string $endLocal,
        ?string $foldUtcOffset,
        ?string $reason,
        BookingDomainContract $contract,
    ): self {
        $enforcement = $contract->constraintEnforcementByKind[$kind] ?? null;
        if ($enforcement === null) {
            throw new BookingValidationException('kind', 'Unknown planning constraint kind.');
        }

        $from = self::date($startDate, 'startDate');
        $until = self::date($endDate, 'endDate');
        if ($until < $from) {
            throw new BookingValidationException('endDate', 'Planning constraint range is inverted.');
        }
        $days = (int) $from->diff($until)->format('%a') + 1;
        if ($days > $contract->constraintMaxDays) {
            throw new BookingValidationException('endDate', 'Planning constraint range is too long.');
        }

        $timed = $kind === 'pause' || $kind === 'unavailability';
        $window = null;
        if ($timed) {
            if ($startLocal === null || $endLocal === null) {
                throw new BookingValidationException(
                    'startLocal',
                    'A timed constraint requires its start and end times.',
                );
            }
            if ($startDate !== $endDate) {
                throw new BookingValidationException('endDate', 'A timed constraint covers exactly one date.');
            }
            $window = AvailabilityWindow::create($startLocal, $endLocal, $foldUtcOffset, $contract);
        } elseif ($startLocal !== null || $endLocal !== null || $foldUtcOffset !== null) {
            throw new BookingValidationException('startLocal', 'An all-day constraint carries no times.');
        }

        $reason = $reason === null ? null : trim($reason);
        if ($reason === '') {
            $reason = null;
        }
        if ($reason !== null && mb_strlen($reason) > 255) {
            throw new BookingValidationException('reason', 'Planning constraint reason is too long.');
        }

        return new self($id, $kind, $enforcement, $startDate, $endDate, $window, $reason);
    }

    public function isStrict(): bool
    {
        return $this->enforcement === self::STRICT;
    }

    /**
     * The half-open UTC interval a *strict* constraint blocks: the timed
     * window converted with the site's DST rules, or local midnight of
     * `startDate` to local midnight of the day after `endDate`. Null for a
     * flexible constraint, which blocks nothing by definition.
     */
    public function blockingInterval(BookingTimePolicy $time): ?OccupiedInterval
    {
        if (!$this->isStrict()) {
            return null;
        }

        if ($this->window !== null) {
            $fold = $this->window->foldUtcOffset;

            return new OccupiedInterval(
                $time->localToUtcWithFoldOffset($this->startDate . ' ' . $this->window->startLocal, $fold),
                $time->localToUtcWithFoldOffset($this->startDate . ' ' . $this->window->endLocal, $fold),
            );
        }

        $dayAfter = self::date($this->endDate, 'endDate')->modify('+1 day')->format('Y-m-d');

        return new OccupiedInterval(
            $time->localToUtcWithFoldOffset($this->startDate . ' 00:00:00', null),
            $time->localToUtcWithFoldOffset($dayAfter . ' 00:00:00', null),
        );
    }

    private static function date(string $value, string $field): \DateTimeImmutable
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d') !== $value) {
            throw new BookingValidationException($field, 'Date must be a real YYYY-MM-DD value.');
        }

        return $date;
    }
}
