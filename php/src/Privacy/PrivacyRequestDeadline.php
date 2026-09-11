<?php

declare(strict_types=1);

namespace Eszter\Privacy;

/**
 * The one-month answer deadline, derived from the reception date (ESZ-163).
 *
 * The same day of the month, `$months` calendar months later, clamped to the
 * last day of the target month when that day does not exist: a request
 * received on 31 January is due on 28 (or 29) February, never on 3 March,
 * which is what PHP's plain `+1 month` overflow would yield. Pure and
 * deterministic, so the stored `deadline_date` and any re-derivation agree.
 */
final class PrivacyRequestDeadline
{
    public static function from(\DateTimeImmutable $receivedDate, int $months): \DateTimeImmutable
    {
        if ($months < 1) {
            throw new \InvalidArgumentException('The deadline must be at least one month after reception.');
        }

        $firstOfTargetMonth = $receivedDate->modify('first day of this month')->modify("+{$months} months");
        $lastDay = (int) $firstOfTargetMonth->format('t');
        $day = min((int) $receivedDate->format('j'), $lastDay);

        return $firstOfTargetMonth->setDate(
            (int) $firstOfTargetMonth->format('Y'),
            (int) $firstOfTargetMonth->format('n'),
            $day,
        );
    }
}
