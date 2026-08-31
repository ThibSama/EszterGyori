<?php

declare(strict_types=1);

namespace Eszter\Security;

/**
 * The answer to one `charge()` (ESZ-084).
 *
 * A value rather than a bare bool because a refusal has to say *how long*: the
 * frozen refusal carries `Retry-After`, and a limiter that only answered yes or
 * no would leave the HTTP layer inventing that number.
 *
 * `retryAfterSeconds` is meaningful only on a refusal, and it is always at least
 * one. A `Retry-After: 0` invites an immediate retry that is certain to be
 * refused again, which is a busy loop the server pays for.
 */
final class RateLimitDecision
{
    private function __construct(
        public readonly bool $allowed,
        public readonly string $scope,
        public readonly int $retryAfterSeconds,
    ) {
    }

    public static function allowed(string $scope): self
    {
        return new self(true, $scope, 0);
    }

    public static function refused(string $scope, int $retryAfterMs): self
    {
        return new self(false, $scope, max(1, (int) ceil($retryAfterMs / 1000)));
    }
}
