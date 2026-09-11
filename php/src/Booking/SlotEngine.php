<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * Deterministic, bounded, in-memory slot computation (ESZ-045).
 *
 * ESZ-150: the engine reads only the shaping facts — duration, buffers,
 * activity — so a single service and a validated combination
 * ({@see BookableOffer}) are the same input to it.
 *
 * ESZ-151: the administrator's {@see BookingTimeRules} and the current
 * instant are inputs too, so the public read, the move read and the
 * transactional revalidation cannot disagree about the lead time, the
 * preferred finish or the overrun — they all call this one method with the
 * same stored rules.
 */
final class SlotEngine
{
    public function __construct(
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
    ) {
    }

    /**
     * `$now` is the instant the lead time is measured from; null (the pure
     * engine under test) applies no lead and no past cut-off. `$timeRules`
     * null means the contract defaults.
     *
     * @param list<WeeklyAvailabilityRule> $weeklyRules
     * @param list<AvailabilityException> $exceptions
     * @param list<OccupiedInterval> $occupied
     * @return list<Slot>
     */
    public function generate(
        BookableService|BookableOffer $service,
        string $fromDate,
        string $untilDate,
        array $weeklyRules,
        array $exceptions,
        array $occupied,
        ?\DateTimeImmutable $now = null,
        ?BookingTimeRules $timeRules = null,
    ): array {
        $timeRules ??= BookingTimeRules::defaults();
        // ESZ-151 rule 1: nothing starts in the past or inside the lead.
        $notBefore = $now === null ? null : $now->add(new \DateInterval('PT' . $timeRules->minimumLeadMinutes . 'M'));

        if (!$service->isActive) {
            throw new BookingValidationException('service', 'Slots cannot be generated for an inactive service.');
        }

        $from = self::date($fromDate, 'fromDate');
        $until = self::date($untilDate, 'untilDate');
        if ($until < $from) {
            throw new BookingValidationException('untilDate', 'Slot date range is inverted.');
        }
        $days = (int) $from->diff($until)->format('%a') + 1;
        if ($days > $this->contract->slotMaxHorizonDays) {
            throw new BookingValidationException('untilDate', 'Slot query exceeds the bounded horizon.');
        }

        foreach ($weeklyRules as $rule) {
            if (!$rule instanceof WeeklyAvailabilityRule) {
                throw new BookingValidationException('weeklyRules', 'Weekly rule list is malformed.');
            }
        }
        foreach ($occupied as $interval) {
            if (!$interval instanceof OccupiedInterval) {
                throw new BookingValidationException('occupied', 'Occupied interval list is malformed.');
            }
        }

        $exceptionsByDate = [];
        foreach ($exceptions as $exception) {
            if (!$exception instanceof AvailabilityException) {
                throw new BookingValidationException('exceptions', 'Exception list is malformed.');
            }
            if (isset($exceptionsByDate[$exception->localDate])) {
                throw new BookingValidationException('exceptions', 'More than one exception exists for a date.');
            }
            $exceptionsByDate[$exception->localDate] = $exception;
        }

        $slots = [];
        for ($date = $from; $date <= $until; $date = $date->modify('+1 day')) {
            $localDate = $date->format('Y-m-d');
            $windows = $this->effectiveWindows($localDate, $weeklyRules, $exceptionsByDate[$localDate] ?? null);

            foreach ($windows as $window) {
                foreach (
                    $this->slotsInWindow($service, $localDate, $window, $occupied, $notBefore, $timeRules) as $slot
                ) {
                    $slots[] = $slot;
                    if (\count($slots) > $this->contract->slotMaxResults) {
                        throw new SlotLimitExceededException('Slot query exceeds the bounded result count.');
                    }
                }
            }
        }

        return $slots;
    }

    /**
     * @param list<WeeklyAvailabilityRule> $rules
     * @return list<AvailabilityWindow>
     */
    private function effectiveWindows(
        string $date,
        array $rules,
        ?AvailabilityException $exception,
    ): array {
        if ($exception !== null) {
            return $exception->kind === 'closed' ? [] : $this->orderedNonOverlapping($exception->windows);
        }

        $windows = [];
        foreach ($rules as $rule) {
            if ($rule->appliesTo($date)) {
                $windows[] = $rule->window;
            }
        }

        return $this->orderedNonOverlapping($windows);
    }

    /**
     * ESZ-151 — the finish rule, inside one effective window.
     *
     * The window is authoritative: the boundary is the *earlier* of the
     * window's end and the preferred finish, so a general finish setting can
     * only narrow a window and never widens a shorter exceptional one. No
     * appointment starts at or after that boundary (a start at 17:30 with a
     * 17:30 finish is refused, whatever its length), and the appointment's own
     * end — start + the real offer duration, without the after-buffer — may
     * run past it by at most the overrun, and never past the window's end.
     * With no preferred finish the window's end is the boundary, so the
     * overrun has nothing to extend and the pre-ESZ-151 fit is exactly what
     * remains.
     *
     * @param list<OccupiedInterval> $occupied
     * @return list<Slot>
     */
    private function slotsInWindow(
        BookableService|BookableOffer $service,
        string $date,
        AvailabilityWindow $window,
        array $occupied,
        ?\DateTimeImmutable $notBefore,
        BookingTimeRules $timeRules,
    ): array {
        $windowStart = $this->time->localToUtcWithFoldOffset(
            $date . ' ' . $window->startLocal,
            $window->foldUtcOffset,
        );
        $windowEnd = $this->time->localToUtcWithFoldOffset(
            $date . ' ' . $window->endLocal,
            $window->foldUtcOffset,
        );
        if ($windowEnd <= $windowStart) {
            throw new BookingValidationException('window', 'DST conversion inverted an availability window.');
        }

        $startMinute = self::minuteOfDay($window->startLocal);
        $endMinute = self::minuteOfDay($window->endLocal);
        $finishMinute = min($endMinute, $timeRules->preferredFinishMinuteOfDay() ?? $endMinute);
        $latestEnd = $this->latestEnd($date, $window, $windowEnd, $endMinute, $finishMinute, $timeRules);
        $grid = $this->contract->slotGridMinutes;
        $candidateMinute = (int) (ceil($startMinute / $grid) * $grid);
        $slots = [];

        for (; $candidateMinute < $finishMinute; $candidateMinute += $grid) {
            $localStart = \sprintf('%02d:%02d:00', intdiv($candidateMinute, 60), $candidateMinute % 60);
            try {
                $startsAt = $this->time->localToUtcWithFoldOffset(
                    $date . ' ' . $localStart,
                    $window->foldUtcOffset,
                );
            } catch (NonexistentLocalTimeException) {
                continue;
            }

            $endsAt = $startsAt->modify('+' . $service->durationMinutes . ' minutes');
            $resourceStart = $startsAt->modify('-' . $service->bufferBeforeMinutes . ' minutes');
            $resourceEnd = $endsAt->modify('+' . $service->bufferAfterMinutes . ' minutes');

            if ($resourceStart < $windowStart || $resourceEnd > $windowEnd) {
                continue;
            }
            if ($endsAt > $latestEnd) {
                continue;
            }
            if ($notBefore !== null && $startsAt < $notBefore) {
                continue;
            }
            if ($this->overlapsOccupied($resourceStart, $resourceEnd, $occupied)) {
                continue;
            }

            $slots[] = new Slot(
                $date,
                substr($localStart, 0, 5),
                $window->foldUtcOffset,
                $startsAt,
                $endsAt,
            );
        }

        return $slots;
    }

    /**
     * The latest instant an appointment may end in this window: the preferred
     * finish plus the overrun, capped by the window's end. When the cap *is*
     * the window's end the already converted instant is reused, so the two
     * checks cannot disagree on a DST date.
     */
    private function latestEnd(
        string $date,
        AvailabilityWindow $window,
        \DateTimeImmutable $windowEnd,
        int $endMinute,
        int $finishMinute,
        BookingTimeRules $timeRules,
    ): \DateTimeImmutable {
        $latestMinute = $finishMinute + $timeRules->maxOverrunMinutes;
        if ($latestMinute >= $endMinute) {
            return $windowEnd;
        }

        $local = \sprintf('%02d:%02d:00', intdiv($latestMinute, 60), $latestMinute % 60);
        try {
            return $this->time->localToUtcWithFoldOffset($date . ' ' . $local, $window->foldUtcOffset);
        } catch (NonexistentLocalTimeException) {
            // A wall time skipped by the spring-forward gap: the last instant
            // "not after" it is the transition itself, i.e. the first existing
            // wall time an hour later.
            $afterGap = \sprintf('%02d:%02d:00', intdiv($latestMinute + 60, 60), ($latestMinute + 60) % 60);

            return $this->time->localToUtcWithFoldOffset($date . ' ' . $afterGap, $window->foldUtcOffset);
        }
    }

    /**
     * @param list<AvailabilityWindow> $windows
     * @return list<AvailabilityWindow>
     */
    private function orderedNonOverlapping(array $windows): array
    {
        usort($windows, static fn (AvailabilityWindow $a, AvailabilityWindow $b): int =>
            [$a->startLocal, $a->endLocal] <=> [$b->startLocal, $b->endLocal]);
        foreach ($windows as $index => $window) {
            $next = $windows[$index + 1] ?? null;
            if ($next !== null && $window->endLocal > $next->startLocal) {
                throw new BookingValidationException('windows', 'Effective availability windows overlap.');
            }
        }

        return $windows;
    }

    /** @param list<OccupiedInterval> $occupied */
    private function overlapsOccupied(
        \DateTimeImmutable $start,
        \DateTimeImmutable $end,
        array $occupied,
    ): bool {
        foreach ($occupied as $interval) {
            if ($start < $interval->endsAtUtc && $interval->startsAtUtc < $end) {
                return true;
            }
        }

        return false;
    }

    private static function date(string $value, string $field): \DateTimeImmutable
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d') !== $value) {
            throw new BookingValidationException($field, 'Date must be a real YYYY-MM-DD value.');
        }

        return $date;
    }

    private static function minuteOfDay(string $time): int
    {
        return ((int) substr($time, 0, 2)) * 60 + (int) substr($time, 3, 2);
    }
}
