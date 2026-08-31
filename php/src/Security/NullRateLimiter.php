<?php

declare(strict_types=1);

namespace Eszter\Security;

/**
 * Admits everything, and says so.
 *
 * Used where there is no database to hold the buckets, which outside production
 * is a legitimate configuration: the public read-only surface opens no connection
 * at all and none of the limited routes is wired without one. Production cannot
 * reach this class — {@see \Eszter\Config\Configuration} refuses to boot without a
 * `database` block, so {@see \Eszter\Kernel} always builds the PDO limiter there.
 *
 * It exists as a named class rather than a `?RateLimiter` null so that "this
 * request was not throttled" is a decision something made, greppable and
 * assertable, instead of the absence of one.
 */
final class NullRateLimiter implements RateLimiter
{
    public function charge(string $scope, string $subject): RateLimitDecision
    {
        return RateLimitDecision::allowed($scope);
    }
}
