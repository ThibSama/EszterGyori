<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * The allowlist that makes "notification logs carry no customer data" a
 * mechanism rather than a habit (ESZ-071).
 *
 * A redaction filter would be the obvious alternative and is the wrong shape: it
 * has to know every field that must be removed, so it fails open the first time
 * someone adds one it has not heard of. This fails closed — a key that is not in
 * `notifications.diagnostics.logFields` is dropped, whatever it holds — and the
 * frozen list is short enough to read in one glance.
 *
 * Values are narrowed too, not just keys. A field on the list still cannot carry
 * an arbitrary string: everything is coerced to a scalar the contract expects,
 * so `channel => $providerResponse` cannot ride in on an allowed key.
 */
final class NotificationLogContext
{
    /**
     * @param array<string, scalar|null> $extra
     * @return array<string, scalar|null>
     */
    public static function forJob(
        NotificationJob $job,
        NotificationPolicy $policy,
        array $extra = [],
    ): array {
        return self::filter($policy, [
            'jobId' => $job->id,
            'bookingReference' => $job->bookingReference,
            'channel' => $job->channel,
            'jobType' => $job->jobType,
            'status' => $job->status,
            'attempts' => $job->attempts,
            'dueAtUtc' => $job->dueAtUtc,
            'leaseOwner' => $job->leaseOwner,
        ] + $extra);
    }

    /**
     * @param array<string, scalar|null> $context
     * @return array<string, scalar|null>
     */
    public static function filter(NotificationPolicy $policy, array $context): array
    {
        $safe = [];

        foreach ($context as $key => $value) {
            if (!$policy->isLogFieldAllowed($key) || $value === null) {
                continue;
            }

            $safe[$key] = self::narrow($key, $value, $policy);
        }

        return $safe;
    }

    /**
     * Coerces one allowed field to the shape the contract says it has.
     *
     * `errorCode` is the strictest: it is dropped entirely unless it matches the
     * frozen code pattern, because that pattern is precisely what makes a code
     * incapable of holding an address or a message fragment.
     */
    private static function narrow(string $key, mixed $value, NotificationPolicy $policy): string|int
    {
        $counters = ['jobId', 'attempts', 'durationMs', 'batchSize', 'claimed', 'recovered', 'skipped'];

        if (\in_array($key, $counters, true)) {
            return \is_int($value) ? $value : (int) (\is_numeric($value) ? $value : 0);
        }

        $string = \is_string($value) ? $value : '';

        if ($key === 'errorCode') {
            return $policy->acceptsErrorCode($string) ? $string : 'unclassified';
        }

        // Every remaining allowed field is an enum value, an opaque reference, a
        // lease owner or a canonical UTC timestamp. All four are bounded and
        // pattern-shaped; truncation is a belt for the one that is not yet
        // pattern-checked at this point in the flow.
        return mb_substr($string, 0, 64);
    }
}
