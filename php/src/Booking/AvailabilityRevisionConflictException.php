<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** A stale editor tried to change the global availability state. */
final class AvailabilityRevisionConflictException extends \RuntimeException
{
    public function __construct(
        public readonly int $expectedRevision,
        public readonly int $currentRevision,
    ) {
        parent::__construct(\sprintf(
            'Expected availability revision %d but the current revision is %d.',
            $expectedRevision,
            $currentRevision,
        ));
    }

    /** @return array<string, int> Safe for the log. */
    public function logContext(): array
    {
        return [
            'expectedRevision' => $this->expectedRevision,
            'currentRevision' => $this->currentRevision,
        ];
    }
}
