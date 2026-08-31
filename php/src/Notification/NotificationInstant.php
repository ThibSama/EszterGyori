<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * The one conversion between the wire's canonical ISO instant and the
 * `DATETIME(3)` text MySQL stores.
 *
 * It exists so that no statement in this namespace ever formats a time inline.
 * Every comparison in the queue — is this job due, has this lease expired, is
 * this reminder too late — is a comparison between two of these strings, and a
 * single mismatched format would make one of those comparisons quietly wrong in
 * a way no CHECK constraint could catch.
 *
 * UTC only, and never the host's default timezone: the runner may execute under
 * any `date.timezone`, and the queue's answers must not depend on which.
 */
final class NotificationInstant
{
    public const DATABASE_FORMAT = 'Y-m-d H:i:s.v';

    public static function database(\DateTimeImmutable $instant): string
    {
        return $instant->setTimezone(new \DateTimeZone('UTC'))->format(self::DATABASE_FORMAT);
    }

    public static function plusSeconds(\DateTimeImmutable $instant, int $seconds): string
    {
        return self::database($instant->modify(\sprintf('%+d seconds', $seconds)));
    }

    public static function minusMinutes(\DateTimeImmutable $instant, int $minutes): string
    {
        return self::database($instant->modify(\sprintf('-%d minutes', $minutes)));
    }

    /** Parses the canonical wire form (`…T…Z`) into a UTC instant. */
    public static function fromIso(string $iso): \DateTimeImmutable
    {
        $parsed = \DateTimeImmutable::createFromFormat(
            'Y-m-d\TH:i:s.v\Z',
            $iso,
            new \DateTimeZone('UTC'),
        );

        if ($parsed === false) {
            throw NotificationException::invalid('instant', "`{$iso}` is not a canonical UTC timestamp.");
        }

        return $parsed;
    }
}
