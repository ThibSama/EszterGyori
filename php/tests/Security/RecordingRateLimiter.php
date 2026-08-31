<?php

declare(strict_types=1);

namespace Eszter\Tests\Security;

use Eszter\Security\RateLimitDecision;
use Eszter\Security\RateLimiter;

/**
 * A limiter that records every charge and refuses the scopes it is told to.
 *
 * The point is the *order* it records. Almost everything worth asserting about
 * {@see \Eszter\Security\RateLimitGuard} is which bucket is charged before which,
 * and a double that only counted calls would prove none of it.
 */
final class RecordingRateLimiter implements RateLimiter
{
    /** @var list<array{scope: string, subject: string}> */
    public array $charges = [];

    /** @param list<string> $refusedScopes */
    public function __construct(private readonly array $refusedScopes = [])
    {
    }

    public function charge(string $scope, string $subject): RateLimitDecision
    {
        $this->charges[] = ['scope' => $scope, 'subject' => $subject];

        return \in_array($scope, $this->refusedScopes, true)
            ? RateLimitDecision::refused($scope, 30_000)
            : RateLimitDecision::allowed($scope);
    }

    /** @return list<string> */
    public function scopes(): array
    {
        return array_map(static fn (array $charge): string => $charge['scope'], $this->charges);
    }
}
