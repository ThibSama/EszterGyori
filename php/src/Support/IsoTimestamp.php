<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * The one canonical timestamp form on the wire: UTC, millisecond precision,
 * trailing `Z` — byte-identical to JavaScript's `Date#toISOString`.
 *
 * Contract: semantic-rules.json `envelope.isoTimestampRoundTrip`.
 *
 * The reference implementation expresses this as a round-trip
 * (`new Date(Date.parse(v)).toISOString() === v`). Parsing strictly against a
 * fixed format is the same predicate stated the other way round, and it is the
 * only way to get the check without a permissive parser in the middle.
 *
 * Known, deliberate divergence: JavaScript also round-trips expanded years
 * (`+275760-09-13T00:00:00.000Z`). Those are rejected here. Rejecting is the
 * safe direction — PHP never accepts a document the reference would refuse —
 * and no such value can arise from this application's own writes.
 */
final class IsoTimestamp
{
    public const FORMAT = 'Y-m-d\TH:i:s.v\Z';

    public static function format(\DateTimeImmutable $instant): string
    {
        return $instant->setTimezone(new \DateTimeZone('UTC'))->format(self::FORMAT);
    }

    public static function isCanonical(mixed $value): bool
    {
        if (!\is_string($value)) {
            return false;
        }

        $parsed = \DateTimeImmutable::createFromFormat(
            self::FORMAT,
            $value,
            new \DateTimeZone('UTC'),
        );

        if ($parsed === false) {
            return false;
        }

        // createFromFormat silently rolls over impossible dates (2026-02-30 →
        // 2026-03-02). Re-formatting catches that; getLastErrors() alone does not
        // report every rollover consistently across PHP versions.
        return self::format($parsed) === $value;
    }
}
