<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** One date-level replacement: either closed or a complete open-window set. */
final class AvailabilityException
{
    /** @param list<AvailabilityWindow> $windows */
    public function __construct(
        public readonly int $id,
        public readonly string $localDate,
        public readonly string $kind,
        public readonly array $windows,
        public readonly ?string $note,
    ) {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $localDate, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d') !== $localDate) {
            throw new BookingValidationException('exceptionDate', 'Exception date must be a real YYYY-MM-DD value.');
        }
        if (!\in_array($kind, ['closed', 'open'], true)) {
            throw new BookingValidationException('exceptionKind', 'Exception must be closed or open.');
        }
        if (($kind === 'closed') !== ($windows === [])) {
            throw new BookingValidationException(
                'exceptionWindows',
                'Closed exceptions have no windows and open exceptions require at least one.',
            );
        }
    }
}
