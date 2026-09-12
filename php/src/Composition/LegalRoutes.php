<?php

declare(strict_types=1);

namespace Eszter\Composition;

use Eszter\Http\Endpoint\AdminLegalInformationEndpoint;
use Eszter\Http\Endpoint\AdminLegalInformationReadEndpoint;
use Eszter\Http\Endpoint\AdminLegalInformationSaveEndpoint;
use Eszter\Http\Endpoint\PublicLegalInformationEndpoint;
use Eszter\Legal\LegalInformationApi;
use Eszter\Http\Router;

/**
 * Composes the legal-information surface (ESZ-165), public and admin, under
 * the same conditions as the booking surface.
 *
 * The public read exists as soon as a legal implementation does — the
 * composition root builds the MySQL one whenever a database is configured,
 * because the document lives there. The admin half additionally needs an
 * authenticated surface, so it is registered only when the root wired one.
 * `/api/admin/settings/legal` is registered under GET and PUT on one path, so
 * the 405 `Allow` header reports `GET, PUT` from what is registered.
 */
final class LegalRoutes
{
    public function __construct(
        private readonly KernelServices $services,
        private readonly LegalInformationApi $legal,
        private readonly ?AuthenticatedServices $auth = null,
    ) {
    }

    public function register(Router $router): void
    {
        $router->register(
            'GET',
            PublicLegalInformationEndpoint::PATH,
            new PublicLegalInformationEndpoint(
                $this->legal,
                $this->services->structural,
                $this->services->logger,
            ),
        );

        if ($this->auth === null) {
            return;
        }

        $admin = [
            $this->legal,
            $this->services->structural,
            $this->services->logger,
            $this->auth->authenticator,
            $this->auth->sessions,
            $this->auth->csrf,
        ];

        $router->register(
            'GET',
            AdminLegalInformationEndpoint::PATH,
            new AdminLegalInformationReadEndpoint(...$admin),
        );
        $router->register(
            'PUT',
            AdminLegalInformationEndpoint::PATH,
            new AdminLegalInformationSaveEndpoint(...$admin),
        );
    }
}
