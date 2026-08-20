<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `POST /api/auth/logout` (ESZ-025 / ESZ-026).
 *
 * ## Authentication is resolved before CSRF
 *
 * A caller with neither a session nor a token gets 401, not 403. The contract
 * fixes this order (`csrf.requirements`) because the alternative leaks: answering
 * 403 first would tell an unauthenticated caller that its *token* was the
 * problem, which implies a session it does not have.
 *
 * ## Why not 204 unconditionally
 *
 * An idempotent logout that always answers 204 would be friendlier and would also
 * be a state-changing endpoint reachable without any credential. Since a CSRF
 * check needs a session to check against, "always 204" would mean "no check at
 * all for the unauthenticated case", and the distinction between *that* and a
 * real logout is exactly what an attacker would probe. 401 keeps the surface
 * uniform: every path through this endpoint has been authenticated and
 * token-checked before it touches anything.
 */
final class AuthLogoutEndpoint
{
    public const PATH = '/api/auth/logout';

    public function __construct(
        private readonly Authenticator $auth,
        private readonly SessionManager $sessions,
        private readonly CsrfGuard $csrf,
    ) {
    }

    public function __invoke(Request $request): Response
    {
        // Throws 401 when the session is absent, unknown, expired, or attached to
        // an account that has since been disabled or deleted.
        $this->auth->requireAccount();

        $session = $this->sessions->current();

        if ($session === null) {
            // Unreachable: requireAccount() already established a live session.
            // Stated rather than assumed, because the alternative to a throw here
            // is a null dereference on the security-critical path.
            throw HttpException::unauthenticated();
        }

        $this->csrf->assert($request, $session);

        $this->auth->logout();

        return Response::empty(204);
    }
}
