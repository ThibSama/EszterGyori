<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Support\IsoTimestamp;

/**
 * Strict typed field extraction and instant/date parsing for booking use-case
 * requests (ESZ-106).
 *
 * Every booking collaborator receives request arrays that the HTTP layer has
 * already validated against the frozen JSON schemas; these helpers are the
 * domain's own re-validation of those arrays, so each use-case class does not
 * carry a private copy of the same field rules. They are stateless and throw
 * {@see BookingValidationException} with the offending field name.
 */
final class BookingRequestFields
{
    /** @param array<string, mixed> $request */
    public static function requiredString(array $request, string $field): string
    {
        $value = $request[$field] ?? null;
        if (!\is_string($value)) {
            throw new BookingValidationException($field, 'Required string is missing.');
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    public static function requiredInt(array $request, string $field): int
    {
        $value = $request[$field] ?? null;
        if (!\is_int($value)) {
            throw new BookingValidationException($field, 'Required integer is missing.');
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    public static function requiredBool(array $request, string $field): bool
    {
        $value = $request[$field] ?? null;
        if (!\is_bool($value)) {
            throw new BookingValidationException($field, 'Required boolean is missing.');
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    public static function nullableString(array $request, string $field): ?string
    {
        $value = $request[$field] ?? null;
        if ($value !== null && !\is_string($value)) {
            throw new BookingValidationException($field, 'Nullable string is malformed.');
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    public static function timestamp(array $request, string $field): \DateTimeImmutable
    {
        $value = self::requiredString($request, $field);
        if (!IsoTimestamp::isCanonical($value)) {
            throw new BookingValidationException($field, 'Timestamp is not canonical UTC.');
        }

        $instant = \DateTimeImmutable::createFromFormat(IsoTimestamp::FORMAT, $value, new \DateTimeZone('UTC'));
        if ($instant === false) {
            throw new BookingValidationException($field, 'Timestamp could not be parsed.');
        }

        return $instant;
    }

    public static function date(string $value, string $field): \DateTimeImmutable
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d') !== $value) {
            throw new BookingValidationException($field, 'Date must be a real YYYY-MM-DD value.');
        }

        return $date;
    }

    /** @param array<string, mixed> $request */
    public static function expectedUpdatedAt(array $request): string
    {
        $expected = self::requiredString($request, 'expectedUpdatedAt');
        if (!IsoTimestamp::isCanonical($expected)) {
            throw new BookingValidationException('expectedUpdatedAt', 'Timestamp is not canonical UTC.');
        }

        return $expected;
    }

    /**
     * The database stores `DATETIME(3)` as `Y-m-d H:i:s.v`; this is the
     * reverse parse every payload conversion needs.
     */
    public static function databaseInstant(string $value): \DateTimeImmutable
    {
        return new \DateTimeImmutable($value, new \DateTimeZone('UTC'));
    }
}
