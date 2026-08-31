<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Contract\ContentValidator;
use Eszter\Http\EntityTag;
use Eszter\Http\PublicPageBootstrap;
use Eszter\Http\PublicPageBootstrapException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Storage\PublishedContentReader;
use Eszter\Storage\StorageException;
use Eszter\Support\Logger;

/**
 * `GET /` and `HEAD /` — the public marketing page (ESZ-021).
 *
 * This is what replaces the Node server. The frontend is a static export with no
 * runtime, so the file on disk is fixed at build time; this endpoint makes the
 * *content* dynamic anyway, by rewriting two elements of that file with the
 * published document before sending it. Publishing therefore changes the site
 * without rebuilding anything, which is the entire point of the CMS on a host
 * with no Node (`docs/hetzner-target-architecture.md` §5).
 *
 * ## Caching is the same implementation as the API
 *
 * `ETag: "published-<revision>"`, `Cache-Control` from the contract, and the same
 * `If-None-Match` comparison, via the same {@see EntityTag}. One publish
 * invalidates the page and `GET /api/content` together, because both tags are the
 * same function of the same revision — asserted by
 * `page.etagMatchesContentEndpoint`.
 *
 * ## Where it deliberately differs from the API
 *
 * `GET /api/content` answers an opaque 500 when content is unusable. This answers
 * **200 with the exported defaults**. The callers are different: a program can act
 * on "unavailable", a visitor cannot, and for them an error page is strictly worse
 * than copy that is a little out of date. The fallback carries no published ETag,
 * so nothing caches it in place of the content it stands in for.
 *
 * The same fallback covers a page that cannot be injected into at all — a stale or
 * truncated export — because the failure mode is identical from the visitor's
 * side, and a half-rewritten document is never sent.
 */
final class PublicPageEndpoint
{
    public const PATH = '/';

    public function __construct(
        private readonly ExportedPageReader $pages,
        private readonly PublishedContentReader $reader,
        private readonly ContentValidator $validator,
        private readonly PublicPageBootstrap $bootstrap,
        private readonly EntityTag $etags,
        private readonly string $cacheControl,
        private readonly string $contentType,
        private readonly Logger $logger,
    ) {
    }

    public function __invoke(Request $request): Response
    {
        // Read before anything else. If the export is missing there is no page to
        // serve at all, and no amount of valid content changes that — this is the
        // one failure here that is not degradable, and it is a deploy fault.
        $html = $this->pages->readExportedPage();

        $envelope = $this->readPublishedEnvelope();

        if ($envelope === null) {
            return $this->fallback($request, $html);
        }

        try {
            $injected = $this->bootstrap->inject($html, $envelope);
        } catch (PublicPageBootstrapException $exception) {
            $this->logger->error('The exported page could not be injected into.', [
                'detail' => $exception->getMessage(),
            ]);

            return $this->fallback($request, $html);
        }

        $etag = $this->etags->forRevision($this->revisionOf($envelope));
        $headers = [
            'ETag' => $etag,
            'Cache-Control' => $this->cacheControl,
            'Content-Type' => $this->contentType,
        ];

        if ($this->etags->ifNoneMatchSelects($request->header('if-none-match'), $etag)) {
            // A 304 keeps ETag and Cache-Control and carries no body — including
            // no Content-Type, matching `content.get.ifNoneMatch.hit`.
            return Response::empty(304, ['ETag' => $etag, 'Cache-Control' => $this->cacheControl]);
        }

        return $this->document($request, $injected, $headers);
    }

    /**
     * The published envelope, or null when it cannot be used.
     *
     * Both failures collapse to null on purpose: from the page's side there is no
     * useful difference between "could not read it" and "read it and it is not a
     * valid document", and the log already carries which one happened.
     *
     * @return array<string, mixed>|null
     */
    private function readPublishedEnvelope(): ?array
    {
        try {
            $envelope = $this->reader->readPublished();
        } catch (StorageException $exception) {
            $this->logger->error('Published content is unreadable; serving exported defaults.', [
                'detail' => $exception->getMessage(),
            ] + $exception->logContext());

            return null;
        }

        // Re-validated on the way out for the same reason `GET /api/content` does
        // it: a drifted document would otherwise be injected into the page and
        // fail silently in the browser, where nobody is watching.
        $result = $this->validator->validate($envelope, ContentValidator::TARGET_PUBLISHED_ENVELOPE);

        if (!$result->valid || !\is_array($result->value)) {
            $this->logger->error('Published content failed validation; serving exported defaults.', [
                'detail' => $result->summary(),
            ]);

            return null;
        }

        /** @var array<string, mixed> */
        return $result->value;
    }

    /** The exported file, unchanged, with no published validator attached. */
    private function fallback(Request $request, string $html): Response
    {
        return $this->document($request, $html, [
            'Cache-Control' => $this->cacheControl,
            'Content-Type' => $this->contentType,
        ]);
    }

    /**
     * Sends a document, honouring HEAD.
     *
     * HEAD answers the identical headers with an empty body. `/` accepts it and
     * the JSON surface does not, which is a considered difference rather than an
     * inconsistency: this is a document that crawlers and uptime monitors probe
     * with HEAD, and 405-ing them would be a self-inflicted wound.
     *
     * @param array<string, string> $headers
     */
    private function document(Request $request, string $html, array $headers): Response
    {
        if ($request->method === 'HEAD') {
            return Response::empty(200, $headers);
        }

        return Response::html(200, $html, $headers);
    }

    /** @param array<string, mixed> $envelope */
    private function revisionOf(array $envelope): int
    {
        /** @var mixed $revision */
        $revision = $envelope['revision'] ?? null;

        // Unreachable through the validator above, which pins revision to a
        // non-negative integer. Stated so the ETag can never be built from
        // anything else.
        return \is_int($revision) && $revision >= 0 ? $revision : 0;
    }
}
