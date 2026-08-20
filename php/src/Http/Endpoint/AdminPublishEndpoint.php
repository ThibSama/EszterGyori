<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `POST /api/admin/content/publish` (ESZ-032).
 *
 * Publishes the stored draft.
 *
 * ## The request body carries no content, on purpose
 *
 * Publish takes what is *stored*. The authoritative draft is re-read and
 * re-validated inside the exclusive lock, and that document is what becomes
 * published. A publish that accepted content would be a save and a publish in
 * one, and the document it published would be one nothing had ever validated as
 * a draft — which is precisely the state the draft/published split exists to make
 * impossible.
 *
 * So the body is validated here with the *structural* validator alone: it is two
 * scalars, `expectedRevision` and nothing else. There is no content in it to run
 * semantic rules against, and reaching for {@see \Eszter\Contract\ContentValidator}
 * would only invite someone to add a content field later without noticing what
 * that changes.
 *
 * ## Atomicity is the storage layer's, and it is one rename
 *
 * The whole read-validate-compare-write sequence runs under one lock
 * acquisition — see {@see \Eszter\Storage\ContentStorage::publishDraft()} — and
 * the only mutation is a single `rename()`. A failure at any step leaves the
 * previous published envelope readable and byte-identical, so no request ever
 * observes a published document assembled from two different operations.
 *
 * ## Cache invalidation is not a step
 *
 * `published.revision` becomes the draft head that was published, and the
 * `"published-<revision>"` ETag is derived from that number alone. A publish that
 * advances the site therefore retires the previous validator on `/` and
 * `/api/content` by construction. There is nothing here to remember to call, and
 * nothing that can be forgotten.
 */
final class AdminPublishEndpoint extends AdminContentEndpoint
{
    public const PATH = '/api/admin/content/publish';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedAgainstSchema($request, 'admin-publish-request.schema.json');
        $envelope = $this->storage->publishDraft($this->expectedRevision($body));

        $revision = $this->revisionOf($envelope);
        $this->logger->info('Content published.', ['revision' => $revision]);

        // No ETag. This is the result of an operation, not a cacheable
        // representation of the published document; `/` and `/api/content` are
        // the only two surfaces that mint that validator, and a second minter
        // would be a second thing to keep in step with the revision.
        return Response::json(200, $envelope, $this->contentHeaders($revision));
    }
}
