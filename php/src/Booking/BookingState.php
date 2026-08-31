<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** Contract-validated appointment state; no string outside the frozen set exists. */
final class BookingState
{
    private function __construct(public readonly string $value)
    {
    }

    public static function fromString(string $value, BookingDomainContract $contract): self
    {
        if (!$contract->acceptsState($value)) {
            throw new BookingValidationException('state', "Unknown booking state {$value}.");
        }

        return new self($value);
    }
}
