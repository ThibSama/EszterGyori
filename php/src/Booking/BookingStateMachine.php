<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** The single transition authority for the V1 appointment lifecycle (ESZ-042). */
final class BookingStateMachine
{
    public function __construct(private readonly BookingDomainContract $contract)
    {
    }

    public function initial(): BookingState
    {
        return BookingState::fromString($this->contract->initialState, $this->contract);
    }

    public function transition(BookingState $from, BookingState $to): BookingState
    {
        if (!\in_array($to->value, $this->contract->nextStates($from->value), true)) {
            throw new InvalidBookingTransitionException($from->value, $to->value);
        }

        return $to;
    }
}
