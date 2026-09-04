<?php

declare(strict_types=1);

namespace Eszter\Composition;

use Eszter\Http\Endpoint\ExportedPageReader;
use Eszter\Http\Endpoint\HealthEndpoint;
use Eszter\Http\Endpoint\PublicContentEndpoint;
use Eszter\Http\Endpoint\PublicPageEndpoint;
use Eszter\Http\EntityTag;
use Eszter\Http\PublicPageBootstrap;
use Eszter\Http\Router;
use Eszter\Storage\PublishedContentReader;

/**
 * Composes the frozen public HTTP surface: `/api/health`, `/api/content` and
 * `/` — and nothing else.
 *
 * Every path registered here must already exist in `http-contract.json`.
 * `/api/admin/*` and `/api/auth/*` stay unregistered on purpose: the contract
 * freezes them at a structured 404, so routing one before it is contracted
 * would be a silent breaking change. The surface is reachable on every
 * deployment, with or without a database.
 *
 * The two reader seams are injected by the composition root:
 *
 *  - `$reader` is the source `GET /api/content` reads from. Production passes
 *    the real {@see \Eszter\Storage\ContentStorage}; the conformance suite
 *    passes a seam so it can replay the contract's storage-failure cases
 *    against the real route.
 *  - `$pages` is the exported HTML `GET /` injects into, for the same reason:
 *    the suite asserts against a known export rather than against whatever
 *    `front/out/` happens to hold.
 */
final class PublicRoutes
{
    public function __construct(
        private readonly KernelServices $services,
        private readonly PublishedContentReader $reader,
        private readonly ExportedPageReader $pages,
    ) {
    }

    public function register(Router $router): void
    {
        $contract = $this->services->artifacts->httpContract();
        /** @var array<string, mixed> $caching */
        $caching = $contract['caching'] ?? [];
        /** @var mixed $cacheControl */
        $cacheControl = $caching['cacheControl'] ?? null;

        if (!\is_string($cacheControl)) {
            throw new \RuntimeException('http-contract.json has no caching.cacheControl.');
        }

        $router->register(
            'GET',
            HealthEndpoint::PATH,
            HealthEndpoint::fromArtifacts($this->services->artifacts, $this->services->clock),
        );

        $etags = EntityTag::fromContract($contract);

        $router->register(
            'GET',
            PublicContentEndpoint::PATH,
            new PublicContentEndpoint($this->reader, $this->services->validator, $etags, $cacheControl),
        );

        // ESZ-021: `/` joined the frozen surface. Until Package 2.1 the front
        // controller was mounted at `/api` and the contract carried a standing PHP
        // exemption saying so; the static export removed the Node server that used
        // to answer here, so the page is now this service's to serve and the
        // exemption is gone.
        //
        // The same `EntityTag` instance backs both routes, which is what makes
        // `page.etagMatchesContentEndpoint` true by construction rather than by
        // two implementations agreeing.
        /** @var mixed $publicPage */
        $publicPage = $contract['publicPage'] ?? null;
        /** @var mixed $pageContentType */
        $pageContentType = \is_array($publicPage) ? ($publicPage['contentType'] ?? null) : null;

        if (!\is_string($pageContentType)) {
            throw new \RuntimeException('http-contract.json has no publicPage.contentType.');
        }

        $page = new PublicPageEndpoint(
            $this->pages,
            $this->reader,
            $this->services->validator,
            PublicPageBootstrap::fromArtifacts($this->services->artifacts),
            $etags,
            $cacheControl,
            $pageContentType,
            $this->services->logger,
        );

        // Registered under both methods rather than special-cased in the router:
        // the contract lists `["GET", "HEAD"]` for this path, and the 405 `Allow`
        // header is built from what is registered, so this is what makes
        // `page.post.methodNotAllowed` answer `Allow: GET, HEAD`.
        $router->register('GET', PublicPageEndpoint::PATH, $page);
        $router->register('HEAD', PublicPageEndpoint::PATH, $page);
    }
}
