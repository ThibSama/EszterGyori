<?php

declare(strict_types=1);

namespace Eszter\Security;

use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;

/**
 * The `rateLimit` block of `http-contract.json`, parsed (ESZ-084).
 *
 * Read from the artifact, never restated in PHP, for the reason
 * {@see \Eszter\Auth\SessionCookie} is: a number typed twice is a number that can
 * disagree with itself, and the copy that wins is whichever was edited last. The
 * artifact is digest-verified at boot, so a policy that reaches this class is one
 * the manifest vouched for.
 *
 * The scopes are `public const` strings rather than free-form arguments so that a
 * call site naming a bucket that does not exist fails at boot — with the whole
 * policy in hand — instead of at the one request that first reached that route.
 */
final class RateLimitPolicy
{
    public const SCOPE_LOGIN_ADDRESS = 'auth.login.address';
    public const SCOPE_LOGIN_IDENTITY = 'auth.login.identity';
    public const SCOPE_BOOKING_CREATE_ADDRESS = 'booking.create.address';
    public const SCOPE_BOOKING_CREATE_GLOBAL = 'booking.create.global';
    public const SCOPE_BOOKING_AVAILABILITY_ADDRESS = 'booking.availability.address';

    /** @param array<string, RateLimitRule> $rules */
    private function __construct(
        private readonly array $rules,
        public readonly int $refusalStatus,
        public readonly string $refusalErrorCode,
        public readonly string $retryAfterHeader,
        public readonly bool $forwardedHeadersTrusted,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        /** @var mixed $block */
        $block = $artifacts->httpContract()['rateLimit'] ?? null;

        if (!\is_array($block)) {
            throw new ContractArtifactException('http-contract.json has no `rateLimit` block.');
        }

        // Asserted rather than read. These three are the properties that make the
        // limiter enforceable at all on a runtime with no shared memory, and a
        // contract that changed any of them would need a different implementation
        // — so the mismatch has to be loud rather than ignored.
        foreach (['store' => 'database', 'clock' => 'application', 'algorithm' => 'gcra'] as $key => $expected) {
            if (($block[$key] ?? null) !== $expected) {
                throw new ContractArtifactException(
                    "http-contract.json rateLimit.{$key} is not `{$expected}`; this implementation cannot honour it.",
                );
            }
        }

        /** @var mixed $refusal */
        $refusal = $block['refusal'] ?? null;
        /** @var mixed $buckets */
        $buckets = $block['buckets'] ?? null;

        if (!\is_array($refusal) || !\is_array($buckets)) {
            throw new ContractArtifactException('http-contract.json rateLimit is malformed.');
        }

        $rules = [];

        /** @var mixed $bucket */
        foreach ($buckets as $scope => $bucket) {
            if (!\is_string($scope) || !\is_array($bucket)) {
                throw new ContractArtifactException('http-contract.json rateLimit.buckets is malformed.');
            }

            if (($bucket['scope'] ?? null) !== $scope) {
                // A bucket whose declared scope differs from its key would be
                // hashed under one name and reported under another, which is a
                // silent way for two rules to share one row.
                throw new ContractArtifactException(
                    "http-contract.json rateLimit bucket `{$scope}` disagrees with its own scope.",
                );
            }

            $rules[$scope] = RateLimitRule::create(
                $scope,
                self::integer($bucket, 'limit', $scope),
                self::integer($bucket, 'periodSeconds', $scope),
                self::integer($bucket, 'burst', $scope),
            );
        }

        foreach (self::requiredScopes() as $scope) {
            if (!isset($rules[$scope])) {
                throw new ContractArtifactException(
                    "http-contract.json rateLimit declares no `{$scope}` bucket, which this application enforces.",
                );
            }
        }

        return new self(
            $rules,
            self::integer($refusal, 'status', 'refusal'),
            self::text($refusal, 'errorCode'),
            self::text($refusal, 'retryAfterHeader'),
            ($block['forwardedHeadersTrusted'] ?? null) === true,
        );
    }

    /** @return list<string> */
    public static function requiredScopes(): array
    {
        return [
            self::SCOPE_LOGIN_ADDRESS,
            self::SCOPE_LOGIN_IDENTITY,
            self::SCOPE_BOOKING_CREATE_ADDRESS,
            self::SCOPE_BOOKING_CREATE_GLOBAL,
            self::SCOPE_BOOKING_AVAILABILITY_ADDRESS,
        ];
    }

    public function rule(string $scope): RateLimitRule
    {
        if (!isset($this->rules[$scope])) {
            throw new \InvalidArgumentException("No rate limit bucket named `{$scope}`.");
        }

        return $this->rules[$scope];
    }

    /** @return list<string> */
    public function scopes(): array
    {
        return array_keys($this->rules);
    }

    /** @param array<mixed> $block */
    private static function integer(array $block, string $key, string $context): int
    {
        /** @var mixed $value */
        $value = $block[$key] ?? null;

        if (!\is_int($value)) {
            throw new ContractArtifactException(
                "http-contract.json rateLimit `{$context}` has no integer `{$key}`.",
            );
        }

        return $value;
    }

    /** @param array<mixed> $block */
    private static function text(array $block, string $key): string
    {
        /** @var mixed $value */
        $value = $block[$key] ?? null;

        if (!\is_string($value) || $value === '') {
            throw new ContractArtifactException("http-contract.json rateLimit.refusal has no `{$key}`.");
        }

        return $value;
    }
}
