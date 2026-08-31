<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** One half-open local civil-time availability window. */
final class AvailabilityWindow
{
    private function __construct(
        public readonly string $startLocal,
        public readonly string $endLocal,
        public readonly ?string $foldUtcOffset,
    ) {
    }

    public static function create(
        string $startLocal,
        string $endLocal,
        ?string $foldUtcOffset,
        BookingDomainContract $contract,
    ): self {
        $start = self::time($startLocal, 'startLocal');
        $end = self::time($endLocal, 'endLocal');

        if ($end <= $start) {
            throw new BookingValidationException('window', 'Availability window must be non-empty and increasing.');
        }
        if ($foldUtcOffset !== null && !\in_array($foldUtcOffset, $contract->foldOffsets, true)) {
            throw new BookingValidationException('foldUtcOffset', 'Fold offset is not valid for Europe/Paris.');
        }

        return new self($start, $end, $foldUtcOffset);
    }

    private static function time(string $value, string $field): string
    {
        $format = preg_match('/^\d{2}:\d{2}$/D', $value) === 1 ? 'H:i' : 'H:i:s';
        $time = \DateTimeImmutable::createFromFormat('!' . $format, $value, new \DateTimeZone('UTC'));
        if ($time === false || $time->format($format) !== $value) {
            throw new BookingValidationException($field, 'Local time must use HH:MM on a real 24-hour clock.');
        }

        if ($time->format('s') !== '00') {
            throw new BookingValidationException($field, 'Availability precision is one minute.');
        }

        return $time->format('H:i:s');
    }
}
