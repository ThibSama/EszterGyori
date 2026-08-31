<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** Deterministic, bounded, in-memory slot computation (ESZ-045). */
final class SlotEngine
{
    public function __construct(
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
    ) {
    }

    /**
     * @param list<WeeklyAvailabilityRule> $weeklyRules
     * @param list<AvailabilityException> $exceptions
     * @param list<OccupiedInterval> $occupied
     * @return list<Slot>
     */
    public function generate(
        BookableService $service,
        string $fromDate,
        string $untilDate,
        array $weeklyRules,
        array $exceptions,
        array $occupied,
    ): array {
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
                foreach ($this->slotsInWindow($service, $localDate, $window, $occupied) as $slot) {
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
     * @param list<OccupiedInterval> $occupied
     * @return list<Slot>
     */
    private function slotsInWindow(
        BookableService $service,
        string $date,
        AvailabilityWindow $window,
        array $occupied,
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
        $grid = $this->contract->slotGridMinutes;
        $candidateMinute = (int) (ceil($startMinute / $grid) * $grid);
        $slots = [];

        for (; $candidateMinute < $endMinute; $candidateMinute += $grid) {
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
