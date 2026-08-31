<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** Explicit Europe/Paris wall-time to UTC conversion, including both DST edges. */
final class BookingTimePolicy
{
    private readonly \DateTimeZone $zone;

    public function __construct(private readonly BookingDomainContract $contract)
    {
        $this->zone = new \DateTimeZone($contract->timezone);
    }

    /**
     * Converts a local `Y-m-d H:i:s` wall time without consulting any process or
     * database default timezone.
     *
     * A spring-forward gap has no UTC candidate and is rejected. A fall-back
     * overlap has two; the caller must provide `+02:00` or `+01:00` (whichever
     * the IANA database says applies) so the instant is never guessed.
     */
    public function localToUtc(string $localTime, ?string $explicitOffset = null): \DateTimeImmutable
    {
        $wall = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $localTime, new \DateTimeZone('UTC'));

        if ($wall === false || $wall->format('Y-m-d H:i:s') !== $localTime) {
            throw new BookingValidationException('localTime', 'Local time must be a real Y-m-d H:i:s value.');
        }

        $wallEpoch = $wall->getTimestamp();
        $transitions = $this->zone->getTransitions($wallEpoch - 172800, $wallEpoch + 172800);
        $offsets = [];

        foreach ($transitions as $transition) {
            $offset = $transition['offset'] ?? null;
            if (\is_int($offset)) {
                $offsets[$offset] = true;
            }
        }

        /** @var array<int, \DateTimeImmutable> $candidates */
        $candidates = [];
        foreach (array_keys($offsets) as $offset) {
            $utc = (new \DateTimeImmutable('@' . ($wallEpoch - $offset)))->setTimezone(new \DateTimeZone('UTC'));
            if ($utc->setTimezone($this->zone)->format('Y-m-d H:i:s') === $localTime) {
                $candidates[$offset] = $utc;
            }
        }

        if ($candidates === []) {
            throw new NonexistentLocalTimeException($localTime);
        }

        if ($explicitOffset === null) {
            if (\count($candidates) > 1) {
                throw new AmbiguousLocalTimeException($localTime);
            }

            return reset($candidates);
        }

        $offset = self::offsetSeconds($explicitOffset);
        if (!isset($candidates[$offset])) {
            throw new BookingValidationException(
                'utcOffset',
                "Offset {$explicitOffset} is not valid for {$localTime} in {$this->contract->timezone}.",
            );
        }

        return $candidates[$offset];
    }

    public function databaseUtc(\DateTimeImmutable $instant): string
    {
        return $instant->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.v');
    }

    /**
     * Uses a stored fold-only choice when, and only when, this wall time is
     * ambiguous. Ordinary civil times do not need an offset and spring gaps
     * remain explicit validation failures.
     */
    public function localToUtcWithFoldOffset(
        string $localTime,
        ?string $foldOffset,
    ): \DateTimeImmutable {
        try {
            return $this->localToUtc($localTime);
        } catch (AmbiguousLocalTimeException $exception) {
            if ($foldOffset === null) {
                throw $exception;
            }

            return $this->localToUtc($localTime, $foldOffset);
        }
    }

    private static function offsetSeconds(string $offset): int
    {
        if (preg_match('/^([+-])(\d{2}):(\d{2})$/', $offset, $match) !== 1) {
            throw new BookingValidationException('utcOffset', 'UTC offset must use +HH:MM or -HH:MM.');
        }

        $hours = (int) $match[2];
        $minutes = (int) $match[3];
        if ($hours > 23 || $minutes > 59) {
            throw new BookingValidationException('utcOffset', 'UTC offset is outside the valid range.');
        }

        $seconds = ($hours * 60 + $minutes) * 60;

        return $match[1] === '-' ? -$seconds : $seconds;
    }
}
