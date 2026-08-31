<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * Time source. Injected everywhere a timestamp is produced so that storage
 * seeding and envelope writes stay deterministic under test.
 */
interface Clock
{
    public function now(): \DateTimeImmutable;

    /**
     * The canonical wire timestamp: exactly what `Date#toISOString` emits.
     *
     * This format is contractual, not cosmetic — `envelope.isoTimestampRoundTrip`
     * in semantic-rules.json rejects anything else.
     */
    public function nowIso(): string;
}
