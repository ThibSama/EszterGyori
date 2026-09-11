<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** ESZ-152 — an update or removal named a constraint id that does not exist. */
final class PlanningConstraintNotFoundException extends \RuntimeException
{
    public function __construct(public readonly int $constraintId)
    {
        parent::__construct("Planning constraint {$constraintId} does not exist.");
    }
}
