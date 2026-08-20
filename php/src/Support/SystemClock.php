<?php

declare(strict_types=1);

namespace Eszter\Support;

final class SystemClock implements Clock
{
    public function now(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
    }

    public function nowIso(): string
    {
        return IsoTimestamp::format($this->now());
    }
}
