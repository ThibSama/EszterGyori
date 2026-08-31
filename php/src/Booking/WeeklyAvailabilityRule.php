<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** A recurring local window with optional inclusive applicability bounds. */
final class WeeklyAvailabilityRule
{
    public function __construct(
        public readonly int $id,
        public readonly int $weekdayIso,
        public readonly AvailabilityWindow $window,
        public readonly ?string $validFrom,
        public readonly ?string $validUntil,
        public readonly bool $isActive,
    ) {
        if ($weekdayIso < 1 || $weekdayIso > 7) {
            throw new BookingValidationException('weekdayIso', 'ISO weekday must be between 1 and 7.');
        }
        self::validateDate($validFrom, 'validFrom');
        self::validateDate($validUntil, 'validUntil');
        if ($validFrom !== null && $validUntil !== null && $validUntil < $validFrom) {
            throw new BookingValidationException('validUntil', 'Validity end cannot precede validity start.');
        }
    }

    public function appliesTo(string $localDate): bool
    {
        $date = self::validateDate($localDate, 'localDate');
        if ($date === null || (int) $date->format('N') !== $this->weekdayIso || !$this->isActive) {
            return false;
        }

        return ($this->validFrom === null || $localDate >= $this->validFrom)
            && ($this->validUntil === null || $localDate <= $this->validUntil);
    }

    private static function validateDate(?string $value, string $field): ?\DateTimeImmutable
    {
        if ($value === null) {
            return null;
        }

        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d') !== $value) {
            throw new BookingValidationException($field, 'Date must be a real YYYY-MM-DD value.');
        }

        return $date;
    }
}
