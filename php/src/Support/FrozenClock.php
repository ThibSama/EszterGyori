<?php

declare(strict_types=1);

namespace Eszter\Support;

/** Test double. Not used by production code paths. */
final class FrozenClock implements Clock
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
}
