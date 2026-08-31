<?php

declare(strict_types=1);

namespace Eszter\Tests\Security;

use Eszter\Contract\ContractArtifactException;
use Eszter\Security\RateLimitPolicy;
use Eszter\Security\RateLimitRule;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-084 — the policy PHP reads, against the artifact the frontend reads.
 *
 * These assertions are about the *parse*, not about the numbers: the numbers are
 * the contract's and `contracts/tests/generated-artifacts.test.ts` pins them. What
 * matters here is that PHP refuses a policy it cannot honour rather than quietly
 * enforcing something weaker, because a limiter that degrades silently is
 * indistinguishable from one that works right up until the day it matters.
 */
final class RateLimitPolicyTest extends TestCase
{
    private RateLimitPolicy $policy;

    protected function setUp(): void
    {
        $this->policy = RateLimitPolicy::fromArtifacts(TestEnvironment::artifacts());
    }

    public function testEveryScopeTheApplicationEnforcesExistsInTheContract(): void
    {
        foreach (RateLimitPolicy::requiredScopes() as $scope) {
            $rule = $this->policy->rule($scope);

            self::assertSame($scope, $rule->scope);
            self::assertGreaterThan(0, $rule->limit);
            self::assertGreaterThan(0, $rule->periodSeconds);
            self::assertGreaterThanOrEqual(1, $rule->burst);
        }
    }

    public function testNamingABucketTheContractDoesNotDeclareFailsLoudly(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->policy->rule('auth.login.nonexistent');
    }

    public function testTheRefusalIsTheFrozenOne(): void
    {
        self::assertSame(429, $this->policy->refusalStatus);
        self::assertSame('RATE_LIMITED', $this->policy->refusalErrorCode);
        self::assertSame('Retry-After', $this->policy->retryAfterHeader);
    }

    /**
     * The property that decides whether the limiter can be bypassed at all.
     *
     * If a forwarding header were trusted, an abuser would send a fresh one per
     * request and every per-address bucket would hold exactly one hit forever.
     */
    public function testForwardingHeadersAreNotTrusted(): void
    {
        self::assertFalse($this->policy->forwardedHeadersTrusted);
    }

    public function testTheEmissionIntervalIsExactAndDerivedFromTheStatedRule(): void
    {
        // 10 per 900 s, burst 5: one unit of allowance every 90 s, and five
        // requests may arrive at the same instant — four intervals of tolerance,
        // because the first request is what sets the arrival time in the first
        // place. See the note on RateLimitRule::$delayToleranceMs.
        $rule = RateLimitRule::create('test.scope', 10, 900, 5);

        self::assertSame(90_000, $rule->emissionIntervalMs);
        self::assertSame(360_000, $rule->delayToleranceMs);

        // burst: 1 means strictly one per interval, not two.
        self::assertSame(0, RateLimitRule::create('test.scope', 10, 900, 1)->delayToleranceMs);

        // Retention outlives the tolerance by a full period, so a row is never
        // swept while it is still refusing anyone.
        self::assertGreaterThan($rule->delayToleranceMs, $rule->retentionMs());
    }

    /**
     * A fractional interval is refused rather than rounded.
     *
     * Rounding would make the decision depend on where it happened, so the
     * contract's arithmetic and PHP's could disagree about the same request while
     * both believed they were right.
     */
    public function testAFractionalEmissionIntervalIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        RateLimitRule::create('test.scope', 7, 1, 1);
    }

    public function testANonPositiveRuleIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        RateLimitRule::create('test.scope', 0, 900, 1);
    }

    /**
     * The three properties that make the limiter enforceable on shared hosting.
     *
     * A contract that moved the store into the process, or the clock into the
     * database, would need a different implementation — so this one refuses to
     * pretend it can honour it.
     */
    public function testAPolicyThisImplementationCannotHonourIsRefused(): void
    {
        foreach ([['store', 'memory'], ['clock', 'database'], ['algorithm', 'fixed-window']] as [$key, $value]) {
            $this->expectExceptionOnMutatedContract($key, $value);
        }
    }

    private function expectExceptionOnMutatedContract(string $key, string $value): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-ratelimit-policy');

        try {
            TestEnvironment::copyContractsWithHttpMutation(
                $directory,
                static function (array $contract) use ($key, $value): array {
                    /** @var array<string, mixed> $rateLimit */
                    $rateLimit = $contract['rateLimit'];
                    $rateLimit[$key] = $value;
                    $contract['rateLimit'] = $rateLimit;

                    return $contract;
                },
            );

            try {
                RateLimitPolicy::fromArtifacts(new \Eszter\Contract\ContractArtifacts($directory));
                self::fail("a rateLimit.{$key} of `{$value}` was accepted");
            } catch (ContractArtifactException $exception) {
                self::assertStringContainsString($key, $exception->getMessage());
            }
        } finally {
            TestEnvironment::removeDirectory($directory);
        }
    }
}
