<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `GET /api/admin/content/draft` (ESZ-030).
 *
 * Returns the stored draft envelope to an authenticated editor.
 *
 * ## No ETag, no conditional requests
 *
 * The obvious thing would be a `"draft-<revision>"` validator mirroring the
 * published one. It is deliberately absent. The draft's revision is already
 * carried by `x-content-revision`, and it is already the input to the one
 * precondition this surface honours; publishing it a second time under a second
 * name invites a client to send it back as `If-Match`, which
 * `optimisticConcurrency` says is ignored. A precondition a client believes in
 * and the server ignores is worse than no precondition at all, so the second name
 * does not exist.
 *
 * Nothing is lost. The response is `no-store` — see the contract for why
 * unpublished editorial work must not be storable rather than merely
 * revalidated — so a 304 could never be served against a cached copy anyway.
 *
 * ## Failures
 *
 * An absent, unknown, expired or destroyed session is 401, as is a session whose
 * account has since been disabled; the base class resolves all of that before
 * this method runs, and none of those responses reads storage or reports a
 * revision. A draft that cannot be read or validated raises out of the storage
 * layer and becomes the opaque 500 `STORAGE_FAILURE` — never a repaired file,
 * never a partial document, and never a message naming what was wrong with it.
 */
final class AdminDraftReadEndpoint extends AdminContentEndpoint
{
    public const PATH = '/api/admin/content/draft';

    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        $envelope = $this->storage->readDraft();

        return Response::json(
            200,
            $envelope,
            $this->contentHeaders($this->revisionOf($envelope)),
        );
    }
}
