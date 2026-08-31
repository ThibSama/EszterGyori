<?php

declare(strict_types=1);

namespace Eszter\Tests;

use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * A clock a test can push forward.
 *
 * {@see \Eszter\Support\FrozenClock} is deliberately immovable, which is right
 * for storage and envelope writes. The notification queue is the one subsystem
 * whose behaviour *is* the passage of time — leases expire, backoffs elapse,
 * reminder windows close — and asserting any of that with `sleep()` would make
 * the suite both slow and flaky. Moving the clock instead makes the assertions
 * exact: a lease is not expired at 119 seconds and is at 121.
 */
final class MovableClock implements Clock
{
    private \DateTimeImmutable $instant;

    public function __construct(string $iso)
    {
        $instant = \DateTimeImmutable::createFromFormat(
            IsoTimestamp::FORMAT,
            $iso,
            new \DateTimeZone('UTC'),
        );

        if ($instant === false) {
            throw new \InvalidArgumentException("Not a canonical ISO timestamp: {$iso}");
        }

        $this->instant = $instant;
    }

    public function now(): \DateTimeImmutable
    {
        return $this->instant;
    }

    public function nowIso(): string
    {
        return IsoTimestamp::format($this->instant);
    }

    public function advanceSeconds(int $seconds): void
    {
        $this->instant = $this->instant->modify(\sprintf('%+d seconds', $seconds));
    }

    public function advanceMinutes(int $minutes): void
    {
        $this->advanceSeconds($minutes * 60);
    }
}
