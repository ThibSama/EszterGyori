<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `GET /api/admin/media` (ESZ-037).
 *
 * Every catalogued asset, newest first, and nothing else. No pagination and no
 * filtering: the library of a five-page site is tens of entries, and a paginated
 * list would be a wire format to maintain for a scroll nobody performs.
 *
 * `no-store`, like the draft. An asset list is a map of unpublished editorial
 * work — the images an editor has gathered but not put on the site yet — and a
 * cached copy in a shared browser is exactly the leak the admin surface's cache
 * policy exists to prevent.
 *
 * It takes no content lock and reads neither `draft.json` nor `published.json`.
 * The library records what *exists*; the content document records what is *used*.
 * A list that consulted the content would be answering a different question and
 * would make an unreadable draft look like a broken media library.
 */
final class AdminMediaListEndpoint extends AdminMediaEndpoint
{
    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        return Response::json(
            200,
            ['assets' => $this->library->assets()],
            $this->mediaHeaders(),
        );
    }
}
