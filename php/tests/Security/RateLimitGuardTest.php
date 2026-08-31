<?php

declare(strict_types=1);

namespace Eszter\Tests\Security;

use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Security\RateLimitGuard;
use Eszter\Security\RateLimitPolicy;
use Eszter\Support\FrozenClock;
use Eszter\Support\Logger;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-084 — which buckets a request is charged to, and in what order.
 *
 * No database here on purpose: the decisions in this class are about routing and
 * ordering, and proving them against real MySQL would only make them slower to
 * prove. `RateLimiterSqlTest` covers what the store has to guarantee.
 */
final class RateLimitGuardTest extends TestCase
{
    private const ADDRESS = '203.0.113.9';

    private string $root;
    private RateLimitPolicy $policy;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-ratelimit-guard');
        $this->policy = RateLimitPolicy::fromArtifacts(TestEnvironment::artifacts());
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testLoginChargesTheAddressBeforeTheIdentity(): void
    {
        $limiter = new RecordingRateLimiter();
        $this->guard($limiter)->assert($this->login('Eszter@Example.COM'), 'req_1');

        self::assertSame(
            [RateLimitPolicy::SCOPE_LOGIN_ADDRESS, RateLimitPolicy::SCOPE_LOGIN_IDENTITY],
            $limiter->scopes(),
        );
        self::assertSame(self::ADDRESS, $limiter->charges[0]['subject']);

        // Normalised with the same rule the account lookup uses, so casing cannot
        // buy a second budget for the same account.
        self::assertSame('eszter@example.com', $limiter->charges[1]['subject']);
    }

    /**
     * The ordering that makes the narrow bucket worth having.
     *
     * A caller hammering one address must exhaust their own allowance *before*
     * touching the operator's, or reaching the per-address limit would already
     * have spent the per-identity one and the site's only administrator could be
     * locked out by someone else's flood.
     */
    public function testARefusedAddressBucketNeverChargesTheIdentityBucket(): void
    {
        $limiter = new RecordingRateLimiter([RateLimitPolicy::SCOPE_LOGIN_ADDRESS]);

        try {
            $this->guard($limiter)->assert($this->login('eszter@example.com'), 'req_2');
            self::fail('a refused login was admitted');
        } catch (HttpException $refusal) {
            self::assertSame(429, $refusal->status);
        }

        self::assertSame([RateLimitPolicy::SCOPE_LOGIN_ADDRESS], $limiter->scopes());
    }

    /**
     * `auth.loginFailure` says a wrong address and a wrong password must be
     * indistinguishable. Throttling must not become the oracle that closes: the
     * refusal has to be byte-identical whichever address was submitted.
     */
    public function testAThrottledLoginRevealsNothingAboutWhetherTheAccountExists(): void
    {
        $refusals = [];

        foreach (['eszter@example.com', 'nobody-at-all@example.invalid'] as $email) {
            $limiter = new RecordingRateLimiter([RateLimitPolicy::SCOPE_LOGIN_ADDRESS]);

            try {
                $this->guard($limiter)->assert($this->login($email), 'req_same');
                self::fail('a refused login was admitted');
            } catch (HttpException $refusal) {
                $refusals[] = [$refusal->status, $refusal->errorCode, $refusal->headers];
            }
        }

        self::assertSame($refusals[0], $refusals[1]);
    }

    public function testALoginBodyWithNoUsableAddressStillChargesTheAddressBucket(): void
    {
        $limiter = new RecordingRateLimiter();
        $request = new Request(
            'POST',
            '/api/auth/login',
            ['content-type' => 'application/json'],
            '{"password":"only"}',
            [],
            self::ADDRESS,
        );

        $this->guard($limiter)->assert($request, 'req_3');

        // Charged once, not skipped. A body with no address is about to fail
        // validation anyway; not charging it would make "omit the field" a way to
        // probe the login route for free.
        self::assertSame([RateLimitPolicy::SCOPE_LOGIN_ADDRESS], $limiter->scopes());
    }

    public function testBookingCreationChargesTheAddressBeforeTheGlobalCeiling(): void
    {
        $limiter = new RecordingRateLimiter();
        $this->guard($limiter)->assert(
            new Request('POST', '/api/bookings', [], '{}', [], self::ADDRESS),
            'req_4',
        );

        self::assertSame(
            [
                RateLimitPolicy::SCOPE_BOOKING_CREATE_ADDRESS,
                RateLimitPolicy::SCOPE_BOOKING_CREATE_GLOBAL,
            ],
            $limiter->scopes(),
        );

        // One shared ceiling, so the subject is a constant rather than the caller.
        self::assertSame('all', $limiter->charges[1]['subject']);
    }

    public function testOneAbusiveAddressCannotSpendTheGlobalCeiling(): void
    {
        $limiter = new RecordingRateLimiter([RateLimitPolicy::SCOPE_BOOKING_CREATE_ADDRESS]);

        try {
            $this->guard($limiter)->assert(
                new Request('POST', '/api/bookings', [], '{}', [], self::ADDRESS),
                'req_5',
            );
            self::fail('a refused booking was admitted');
        } catch (HttpException) {
        }

        self::assertSame([RateLimitPolicy::SCOPE_BOOKING_CREATE_ADDRESS], $limiter->scopes());
    }

    /**
     * The bypass this whole design exists to close.
     *
     * If a forwarding header decided the bucket, an abuser would send a fresh one
     * per request and every per-address rule would hold exactly one hit forever.
     */
    public function testAForwardingHeaderNeverChangesTheChargedSubject(): void
    {
        $limiter = new RecordingRateLimiter();

        $this->guard($limiter)->assert(
            new Request(
                'POST',
                '/api/bookings',
                [
                    'x-forwarded-for' => '198.51.100.1',
                    'x-real-ip' => '198.51.100.2',
                    'forwarded' => 'for=198.51.100.3',
                ],
                '{}',
                [],
                self::ADDRESS,
            ),
            'req_6',
        );

        self::assertSame(self::ADDRESS, $limiter->charges[0]['subject']);
    }

    /**
     * A request with no peer address is charged to a shared bucket rather than
     * skipping the limiter, or "arrive without one" would be the documented way
     * past every rule.
     */
    public function testARequestWithNoPeerAddressIsStillCharged(): void
    {
        $limiter = new RecordingRateLimiter();

        $this->guard($limiter)->assert(new Request('POST', '/api/bookings', [], '{}'), 'req_7');

        self::assertSame('unknown', $limiter->charges[0]['subject']);
    }

    /**
     * A wrong method is a 405 the router answers for free. Charging it would let
     * anyone drain a bucket with requests the application never intended to act
     * on, which is a denial of service built out of the defence against one.
     */
    public function testAMethodTheRouteDoesNotAcceptIsNotCharged(): void
    {
        $limiter = new RecordingRateLimiter();

        $this->guard($limiter)->assert(
            new Request('GET', '/api/bookings', [], '', [], self::ADDRESS),
            'req_8',
        );
        $this->guard($limiter)->assert(
            new Request('POST', '/api/health', [], '{}', [], self::ADDRESS),
            'req_9',
        );

        self::assertSame([], $limiter->charges);
    }

    public function testTheRefusalCarriesRetryAfterAndNothingElse(): void
    {
        $limiter = new RecordingRateLimiter([RateLimitPolicy::SCOPE_BOOKING_CREATE_ADDRESS]);

        try {
            $this->guard($limiter)->assert(
                new Request('POST', '/api/bookings', [], '{}', [], self::ADDRESS),
                'req_10',
            );
            self::fail('a refused booking was admitted');
        } catch (HttpException $refusal) {
            self::assertSame(429, $refusal->status);
            self::assertSame('RATE_LIMITED', $refusal->errorCode);
            self::assertSame(['Retry-After' => '30'], $refusal->headers);
        }
    }

    private function guard(RecordingRateLimiter $limiter): RateLimitGuard
    {
        return new RateLimitGuard(
            $limiter,
            $this->policy,
            new Logger($this->root . '/app.log', 'debug', new FrozenClock('2026-03-01T09:00:00.000Z')),
        );
    }

    private function login(string $email): Request
    {
        return new Request(
            'POST',
            '/api/auth/login',
            ['content-type' => 'application/json'],
            (string) json_encode(['email' => $email, 'password' => 'whatever']),
            [],
            self::ADDRESS,
        );
    }
}
