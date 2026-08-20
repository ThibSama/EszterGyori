<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `POST /api/auth/login` (ESZ-025 / ESZ-026).
 *
 * ## The order of the four checks is the contract
 *
 *  1. **Malformed JSON** — already rejected before routing, by the kernel's body
 *     guard, as 400 `INVALID_JSON`.
 *  2. **CSRF** — before the body is looked at, so an unauthorised caller never
 *     gets this endpoint to parse or act on bytes it chose.
 *  3. **Shape** — 400 `VALIDATION_FAILED`, driven by the generated
 *     `login-request.schema.json` rather than a hand-written second schema.
 *  4. **Credentials** — 401 `INVALID_CREDENTIALS`, one answer for all three ways
 *     it can fail.
 *
 * Step 2 needs a session to compare the token against, and a caller arriving with
 * no session has nothing that could match — so it is a 403 rather than a reason
 * to mint a session. That also means an unauthenticated flood of login attempts
 * cannot create session rows.
 */
final class AuthLoginEndpoint
{
    public const PATH = '/api/auth/login';

    public function __construct(
        private readonly Authenticator $auth,
        private readonly SessionManager $sessions,
        private readonly CsrfGuard $csrf,
        private readonly StructuralValidator $structure,
    ) {
    }

    public function __invoke(Request $request): Response
    {
        $session = $this->sessions->current();

        if ($session === null) {
            throw HttpException::csrfTokenInvalid('Login attempted without a session to bind a token to.');
        }

        $this->csrf->assert($request, $session);

        $credentials = $this->decode($request->rawBody);

        // A successful login rotates the session id inside login(); the response
        // body is then rebuilt against the *new* session, so the CSRF token the
        // client walks away with is the one bound to its authenticated session.
        $account = $this->auth->login($credentials['email'], $credentials['password']);

        return Response::json(200, $this->auth->sessionResponse($account));
    }

    /**
     * @return array{email: string, password: string}
     * @throws HttpException 400 VALIDATION_FAILED
     */
    private function decode(string $rawBody): array
    {
        /** @var mixed $decoded */
        $decoded = json_decode($rawBody === '' ? 'null' : $rawBody, true);

        $issues = $this->structure->validate($decoded, 'login-request.schema.json');

        if ($issues !== []) {
            // The issue paths name `email` and `password` and nothing sensitive,
            // but they still go only to the log: the response body is the frozen
            // envelope, which carries no detail by construction.
            throw HttpException::validationFailed(
                'Login body rejected: ' . implode(', ', array_map(
                    static fn ($issue): string => $issue->path,
                    $issues,
                )),
            );
        }

        /** @var array{email: string, password: string} $decoded */
        return $decoded;
    }
}
