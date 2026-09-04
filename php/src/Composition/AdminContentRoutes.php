<?php

declare(strict_types=1);

namespace Eszter\Composition;

use Eszter\Http\Endpoint\AdminDraftReadEndpoint;
use Eszter\Http\Endpoint\AdminDraftSaveEndpoint;
use Eszter\Http\Endpoint\AdminPublishEndpoint;
use Eszter\Http\Endpoint\AdminResetEndpoint;
use Eszter\Http\Router;

/**
 * Composes the admin content surface (ESZ-030/031/032/033): draft read and
 * save, publish and reset.
 *
 * Registered alongside the `/api/auth/*` endpoints rather than beside the
 * public routes, and gated on the same condition, because they share the thing
 * that makes them possible: a session store. A deployment with no database has
 * nowhere to keep a session, so it can authenticate nobody, so routing these
 * would only produce endpoints that answer 401 forever. `Configuration`
 * guarantees production is never such a deployment.
 *
 * These routes read and write through the real
 * {@see \Eszter\Storage\ContentStorage} — not the `PublishedContentReader`
 * seam the public routes accept.
 * That seam exists so the conformance suite can replay storage *failures*
 * against a read-only surface; a writing surface has to be exercised against
 * a real directory, because atomic replacement, locking and the revision
 * sequence are precisely what a fixture would fake away.
 *
 * `/api/admin/content/draft` is registered under two methods on one path, so
 * the 405 `Allow` header is built from what is registered and reports
 * `GET, PUT` without anything restating it.
 */
final class AdminContentRoutes
{
    public function __construct(
        private readonly KernelServices $services,
        private readonly AuthenticatedServices $auth,
    ) {
    }

    public function register(Router $router): void
    {
        /** @var array<string, mixed> $adminContent */
        $adminContent = $this->services->artifacts->adminContentContract();
        /** @var mixed $cacheControl */
        $cacheControl = $adminContent['cacheControl'] ?? null;
        /** @var mixed $revisionHeader */
        $revisionHeader = $adminContent['revisionHeader'] ?? null;

        if (!\is_string($cacheControl) || !\is_string($revisionHeader)) {
            throw new \RuntimeException(
                'http-contract.json has no adminContent.cacheControl/revisionHeader.',
            );
        }

        $dependencies = [
            $this->auth->authenticator,
            $this->auth->sessions,
            $this->auth->csrf,
            $this->services->storage,
            $this->services->validator,
            $this->services->structural,
            $this->services->artifacts,
            $this->services->logger,
            $cacheControl,
            $revisionHeader,
        ];

        $router->register(
            'GET',
            AdminDraftReadEndpoint::PATH,
            new AdminDraftReadEndpoint(...$dependencies),
        );
        $router->register(
            'PUT',
            AdminDraftSaveEndpoint::PATH,
            new AdminDraftSaveEndpoint(...$dependencies),
        );
        $router->register(
            'POST',
            AdminPublishEndpoint::PATH,
            new AdminPublishEndpoint(...$dependencies),
        );
        $router->register(
            'POST',
            AdminResetEndpoint::PATH,
            new AdminResetEndpoint(...$dependencies),
        );
    }
}
