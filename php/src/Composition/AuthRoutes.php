<?php

declare(strict_types=1);

namespace Eszter\Composition;

use Eszter\Http\Endpoint\AuthLoginEndpoint;
use Eszter\Http\Endpoint\AuthLogoutEndpoint;
use Eszter\Http\Endpoint\AuthSessionEndpoint;
use Eszter\Http\Router;

/**
 * Composes the `/api/auth/*` endpoints: session read, login and logout.
 *
 * This is the smallest authenticated surface and the one every admin surface
 * builds on. The composition root registers it — like
 * {@see AdminContentRoutes}, {@see AdminMediaRoutes} and the admin half of
 * {@see BookingRoutes} — only when an authenticated surface is wired at all,
 * which happens only where there is a session store to keep sessions in.
 *
 * `/admin` itself is *not* registered here and never will be. It is a static
 * file served by Apache, it enforces nothing, and every guarantee about who
 * may do what is made by these routes (`auth.accessControl`).
 */
final class AuthRoutes
{
    public function __construct(
        private readonly KernelServices $services,
        private readonly AuthenticatedServices $auth,
    ) {
    }

    public function register(Router $router): void
    {
        $router->register(
            'GET',
            AuthSessionEndpoint::PATH,
            new AuthSessionEndpoint($this->auth->authenticator),
        );
        $router->register(
            'POST',
            AuthLoginEndpoint::PATH,
            new AuthLoginEndpoint(
                $this->auth->authenticator,
                $this->auth->sessions,
                $this->auth->csrf,
                $this->services->structural,
            ),
        );
        $router->register(
            'POST',
            AuthLogoutEndpoint::PATH,
            new AuthLogoutEndpoint(
                $this->auth->authenticator,
                $this->auth->sessions,
                $this->auth->csrf,
            ),
        );
    }
}
