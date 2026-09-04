<?php

declare(strict_types=1);

namespace Eszter\Composition;

use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;

/**
 * The authenticated surface's shared services (ESZ-025 / ESZ-026).
 *
 * Built by the composition root exactly when the authenticated surface is
 * wired — that is, when both an account directory and a session store exist —
 * and shared by every surface that must answer to a session: the `/api/auth/*`
 * endpoints and the admin content, media and booking routes.
 *
 * The three objects are deliberately built once and passed around as one
 * bundle: the endpoints hold references to the *same* {@see Authenticator}
 * and {@see CsrfGuard} instances, exactly as the kernel used to construct
 * them before ESZ-105 split the surfaces into composers.
 */
final class AuthenticatedServices
{
    public function __construct(
        public readonly Authenticator $authenticator,
        public readonly SessionManager $sessions,
        public readonly CsrfGuard $csrf,
    ) {
    }
}
