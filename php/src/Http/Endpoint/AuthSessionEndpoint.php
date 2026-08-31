<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Auth\Authenticator;
use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `GET /api/auth/session` (ESZ-025).
 *
 * Reports authentication state and hands out the CSRF token. It answers 200 to
 * everyone, including an anonymous caller, and that is the design rather than an
 * oversight: it is the endpoint a client uses to find out whether it is signed in
 * and to obtain the token every *other* call needs, so requiring authentication
 * here would make it impossible to log in at all.
 *
 * It changes no state and therefore requires no token itself
 * (`csrf.readsAreExempt`). It does create an anonymous session row when there is
 * none, because a token has to be bound to something.
 */
final class AuthSessionEndpoint
{
    public const PATH = '/api/auth/session';

    public function __construct(private readonly Authenticator $auth)
    {
    }

    public function __invoke(Request $request): Response
    {
        return Response::json(200, $this->auth->sessionResponse($this->auth->currentAccount()));
    }
}
