<?php

declare(strict_types=1);

namespace Eszter\Composition;

use Eszter\Http\Endpoint\AdminMediaDeleteEndpoint;
use Eszter\Http\Endpoint\AdminMediaEndpoint;
use Eszter\Http\Endpoint\AdminMediaListEndpoint;
use Eszter\Http\Endpoint\AdminMediaUploadEndpoint;
use Eszter\Http\Router;
use Eszter\Media\ImagePipeline;
use Eszter\Media\MediaIngest;
use Eszter\Media\UploadTransport;

/**
 * Composes the admin media surface (ESZ-036 / ESZ-037): list, upload and
 * delete on `/api/admin/media`.
 *
 * Gated on the same condition as the admin content surface and for the same
 * reason: a deployment with no session store can authenticate nobody, so
 * routing these would only produce endpoints that answer 401 forever.
 *
 * Three verbs on one path, registered separately, so the 405 `Allow` header is
 * built from what is registered and reports `DELETE, GET, POST` without
 * anything restating it. There is no `{id}` route: `Router` is exact-path by
 * construction, and `mediaDeleteRequestSchema` argues why the id travels in
 * the body instead.
 *
 * The delete endpoint takes the real {@see \Eszter\Storage\ContentStorage},
 * not the `PublishedContentReader` seam the public routes accept, because it
 * must read the *authoritative* draft as well as the published document — and
 * the seam exists to fake published reads, which is exactly what a reference
 * check must not be given.
 *
 * The upload transport is the ESZ-036 seam: `is_uploaded_file()` answers only
 * for paths PHP itself wrote while parsing the current request, which no test
 * can arrange — and the parts of the ingest worth testing all come after the
 * move. The composition root passes `null`'s replacement
 * ({@see \Eszter\Media\PhpUploadTransport}) in production and the seam in the
 * media suites.
 */
final class AdminMediaRoutes
{
    public function __construct(
        private readonly KernelServices $services,
        private readonly AuthenticatedServices $auth,
        private readonly UploadTransport $transport,
    ) {
    }

    public function register(Router $router): void
    {
        $images = new ImagePipeline($this->services->media);

        $shared = [
            $this->auth->authenticator,
            $this->auth->sessions,
            $this->auth->csrf,
            $this->services->media,
            $this->services->mediaLibrary,
            $this->services->structural,
            $this->services->logger,
        ];

        $router->register(
            'GET',
            AdminMediaEndpoint::PATH,
            new AdminMediaListEndpoint(...$shared),
        );
        $router->register(
            'POST',
            AdminMediaEndpoint::PATH,
            new AdminMediaUploadEndpoint(...$shared, ingest: new MediaIngest(
                $this->services->media,
                $images,
                $this->services->mediaLibrary,
                $this->services->structural,
                $this->transport,
                $this->services->clock,
                $this->services->logger,
            )),
        );
        $router->register(
            'DELETE',
            AdminMediaEndpoint::PATH,
            new AdminMediaDeleteEndpoint(...$shared, storage: $this->services->storage),
        );
    }
}
