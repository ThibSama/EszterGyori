<?php

declare(strict_types=1);

namespace Eszter\Security;

use Eszter\Admin\AdminEmail;
use Eszter\Http\Endpoint\AuthLoginEndpoint;
use Eszter\Http\Endpoint\AuthSessionEndpoint;
use Eszter\Http\Endpoint\PublicBookingAvailabilityEndpoint;
use Eszter\Http\Endpoint\PublicBookingCreateEndpoint;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Support\Logger;

/**
 * Decides which buckets a request is charged to, and refuses it (ESZ-084).
 *
 * ## Why this sits before the router
 *
 * `rateLimitPolicy.refusal.enforcedBefore` is the whole point: the work these
 * rules bound is work the route does *first thing*. Login's cost is the Argon2
 * verification, booking's is a row lock on the singleton serialization row, and
 * availability's is up to ninety days of slot computation. A limiter consulted
 * inside the endpoint would already have paid for the thing it was meant to
 * prevent, so the check happens in {@see \Eszter\Kernel::handle()} between the
 * body guard and dispatch — after the request is known to be well-formed and
 * before anything acts on it.
 *
 * ## Narrowest bucket first, and stop at the first refusal
 *
 * Two of the three routes are guarded by a pair of buckets, and the order is not
 * cosmetic. On login the per-address bucket is charged before the per-identity
 * one, so a caller hammering a single address exhausts their *own* allowance and
 * is refused before they can spend any of the operator's — otherwise the narrow
 * bucket would be pointless, because reaching it would already have burned the
 * wide one. The same reasoning puts the per-address booking bucket ahead of the
 * global ceiling: one abusive source must not be able to spend the allowance that
 * exists to absorb a distributed attack.
 *
 * A refusal therefore charges exactly the buckets up to and including the one
 * that refused, and no later bucket is touched.
 *
 * ## The login identity is read from the body, and never validated here
 *
 * The submitted address is normalised with {@see AdminEmail::normalize()} — the
 * same normalisation the account lookup uses, so `A@B.COM` and `a@b.com` cannot
 * be two budgets — and is otherwise taken as given. Nothing here checks whether
 * it is well-formed or whether it names an account, because both checks would
 * make the throttle behave differently for a real address than for an invented
 * one, and `auth.loginFailure` exists to make those two indistinguishable. A body
 * with no usable address is charged to the per-address bucket alone and then
 * fails validation in the endpoint, exactly as it did before this class existed.
 *
 * ## The one GET that is charged (ESZ-130)
 *
 * Every charge above keys on `POST`. The single exception is
 * `GET /api/auth/session` when no live session was loaded — the anonymous
 * session read that opens a durable row and a CSRF token — charged through
 * {@see assertSessionBootstrap()} to `auth.session.bootstrap.address` before
 * the route can create anything. All other reads stay uncharged, and in
 * particular a session read that found a live session is never charged.
 */
final class RateLimitGuard
{
    public function __construct(
        private readonly RateLimiter $limiter,
        private readonly RateLimitPolicy $policy,
        private readonly Logger $logger,
    ) {
    }

    /**
     * Charges every bucket this request is subject to, in order.
     *
     * @throws HttpException 429 RATE_LIMITED at the first bucket that refuses.
     */
    public function assert(Request $request, string $requestId): void
    {
        foreach ($this->chargesFor($request) as [$scope, $subject]) {
            $decision = $this->limiter->charge($scope, $subject);

            if ($decision->allowed) {
                continue;
            }

            $this->refuse($request, $requestId, $scope, $decision);
        }
    }

    /**
     * The one GET the limiter guards (ESZ-130): the anonymous session read.
     *
     * `GET /api/auth/session` answers 200 to everyone and, when the caller has
     * no live session, opens a durable anonymous row carrying a CSRF token —
     * which is why it is the only read on the surface worth bounding: a caller
     * who never keeps the cookie could otherwise mint a row per request
     * forever. {@see \Eszter\Kernel::handle()} calls this only when the
     * request found no live session; the method re-checks method and path so
     * that no future caller can widen the charge by accident.
     *
     * The charge happens before the route runs, so a refusal creates no
     * session row, no CSRF token and no cookie, and the refusal reveals
     * nothing about any account or session.
     *
     * @throws HttpException 429 RATE_LIMITED when the bucket refuses.
     */
    public function assertSessionBootstrap(Request $request, string $requestId): void
    {
        if ($request->method !== 'GET' || $request->path !== AuthSessionEndpoint::PATH) {
            return;
        }

        $scope = RateLimitPolicy::SCOPE_SESSION_BOOTSTRAP_ADDRESS;
        $decision = $this->limiter->charge($scope, $request->rateLimitAddress());

        if ($decision->allowed) {
            return;
        }

        $this->refuse($request, $requestId, $scope, $decision);
    }

    /**
     * The shared refusal: one log line and one frozen 429 envelope.
     *
     * The one place the scope and the caller are written down together. It is a
     * log line, not a response: an operator needs to know which rule fired and
     * against whom, and the caller must learn neither.
     *
     * @throws HttpException 429 RATE_LIMITED
     */
    private function refuse(
        Request $request,
        string $requestId,
        string $scope,
        RateLimitDecision $decision,
    ): never {
        $this->logger->warn('Request refused by a rate limit.', [
            'requestId' => $requestId,
            'scope' => $scope,
            'path' => $request->path,
            'retryAfterSeconds' => $decision->retryAfterSeconds,
        ]);

        throw HttpException::rateLimited(
            $this->policy->retryAfterHeader,
            $decision->retryAfterSeconds,
            "Rate limit `{$scope}` refused the request.",
        );
    }

    /**
     * The ordered (scope, subject) pairs this request is charged to.
     *
     * Keyed on method *and* path. A `GET` on a POST-only route is a 405 the
     * router will answer for nothing, and charging it would let anyone drain a
     * bucket with requests the application was never going to act on.
     *
     * @return list<array{0: string, 1: string}>
     */
    private function chargesFor(Request $request): array
    {
        if ($request->method !== 'POST') {
            return [];
        }

        $address = $request->rateLimitAddress();

        if ($request->path === AuthLoginEndpoint::PATH) {
            $charges = [[RateLimitPolicy::SCOPE_LOGIN_ADDRESS, $address]];
            $identity = $this->loginIdentity($request);

            if ($identity !== null) {
                $charges[] = [RateLimitPolicy::SCOPE_LOGIN_IDENTITY, $identity];
            }

            return $charges;
        }

        return match ($request->path) {
            PublicBookingCreateEndpoint::PATH => [
                [RateLimitPolicy::SCOPE_BOOKING_CREATE_ADDRESS, $address],
                // A constant subject: this bucket is one shared ceiling, not a
                // per-caller quota. It is what keeps a thousand addresses sending
                // one booking each from filling a real person's week.
                [RateLimitPolicy::SCOPE_BOOKING_CREATE_GLOBAL, 'all'],
            ],
            PublicBookingAvailabilityEndpoint::PATH => [
                [RateLimitPolicy::SCOPE_BOOKING_AVAILABILITY_ADDRESS, $address],
            ],
            default => [],
        };
    }

    /**
     * The normalised address the login body submitted, or null.
     *
     * Decoding here costs nothing: the body has already passed the 64 kB guard
     * and, on the JSON content type, has already been decoded once to prove it
     * parses. A body that is not an object, or carries no string `email`, yields
     * null and the identity bucket is simply not charged.
     */
    private function loginIdentity(Request $request): ?string
    {
        if ($request->rawBody === '') {
            return null;
        }

        /** @var mixed $decoded */
        $decoded = json_decode($request->rawBody, true);

        if (!\is_array($decoded)) {
            return null;
        }

        /** @var mixed $email */
        $email = $decoded['email'] ?? null;

        if (!\is_string($email) || $email === '') {
            return null;
        }

        // Bounded before hashing. The address is attacker-chosen and the body may
        // legitimately be up to 64 kB, so an unbounded value here would let one
        // request hash sixty kilobytes — cheap, but cheaper still to refuse. The
        // contract's own maximum is far below this and a longer value cannot name
        // an account anyway.
        return AdminEmail::normalize(substr($email, 0, 320));
    }
}
