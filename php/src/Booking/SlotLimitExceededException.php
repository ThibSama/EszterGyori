<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** Slot generation would exceed the frozen result-count safety limit. */
final class SlotLimitExceededException extends \RuntimeException
{
}
