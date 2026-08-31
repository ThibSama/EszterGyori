<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `POST /api/admin/content/reset` (ESZ-033).
 *
 * Discards the draft and rebuilds it from an explicitly named source. The only
 * source this package defines is the current published content.
 *
 * ## `source` is required even though one value is legal
 *
 * Because the operation destroys unpublished work, and the field is what makes
 * the caller state what it is destroying that work *in favour of*. A bare
 * `POST …/reset` reads as "reset to whatever the server decides", which is the
 * ambiguity `docs/backend-target-architecture.md` left open when it described
 * this route as recreating the draft "from default or published content". Naming
 * the source closes it, and a client written today against `source: "published"`
 * keeps meaning what it means if `"defaults"` is ever added.
 *
 * The enum is read from the generated schema, not restated here, so adding a
 * value is a contract change rather than a PHP edit.
 *
 * ## Published content is read and never written
 *
 * This route opens `published.json` to copy its content and writes `draft.json`
 * alone. There is no path through it that moves the published revision or
 * changes what the public site serves — which is the entire point of resetting
 * *to* published: an editor undoing their work must not, in the same act,
 * republish it.
 *
 * ## It is not a lighter operation than a save
 *
 * Same authentication, same CSRF token, same `expectedRevision` precondition, and
 * the new draft takes the next revision like any other write. The temptation is
 * to treat "go back to what was already published" as harmless and skip the
 * precondition; that would make reset the one draft mutation the concurrency
 * check cannot see, and a concurrent editor's next save would silently undo it.
 */
final class AdminResetEndpoint extends AdminContentEndpoint
{
    public const PATH = '/api/admin/content/reset';

    /** The only source Package 3.1 defines. Cross-checked against the contract. */
    private const SOURCE_PUBLISHED = 'published';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedAgainstSchema($request, 'admin-reset-request.schema.json');

        /** @var mixed $source */
        $source = $body['source'] ?? null;

        if ($source !== self::SOURCE_PUBLISHED) {
            // Unreachable: the schema's enum already rejected anything else. The
            // check stands so that widening the contract's enum without teaching
            // this method the new source fails loudly, rather than silently
            // resetting to published under a name that says otherwise.
            throw HttpException::validationFailed('Unsupported reset source.');
        }

        $envelope = $this->storage->resetDraftToPublished($this->expectedRevision($body));

        $revision = $this->revisionOf($envelope);
        $this->logger->info('Draft reset from published content.', ['revision' => $revision]);

        return Response::json(200, $envelope, $this->contentHeaders($revision));
    }
}
