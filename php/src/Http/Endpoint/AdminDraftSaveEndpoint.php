<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Contract\ContentValidator;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Media\DanglingMediaReferenceException;

/**
 * `PUT /api/admin/content/draft` (ESZ-031).
 *
 * Replaces the draft with a complete document, provided the caller has seen the
 * current head.
 *
 * ## Validated here, stored there
 *
 * The submitted document is contract-validated — structure *and* every semantic
 * rule — before the storage layer is called at all. The split matters for what
 * the caller is told: a document the caller sent is the caller's problem and
 * answers 400 `VALIDATION_FAILED`, whereas a document already on disk failing
 * validation is a fault of the service and answers the opaque 500. Validating
 * only inside the storage layer would collapse the two, and every bad save would
 * look like an outage.
 *
 * It also means a rejected save never takes the exclusive lock, so a client
 * looping on an invalid document cannot stall an editor who is saving a good one.
 *
 * ## Whole documents only
 *
 * There is no patch format. `adminDraftSaveOutcome` gives the reasons; the one
 * that shows up here is that the precondition would otherwise be meaningless — a
 * caller that sends a whole document has necessarily seen a whole document,
 * whereas a caller sending one field may have seen nothing at all.
 *
 * ## The public site is not involved
 *
 * Saving reads and writes `draft.json` and nothing else. `published.json` is not
 * opened, its revision does not move, and `/` and `/api/content` keep serving and
 * caching exactly what they served before. Publishing is a separate, explicit act.
 */
final class AdminDraftSaveEndpoint extends AdminContentEndpoint
{
    public const PATH = '/api/admin/content/draft';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, ContentValidator::TARGET_ADMIN_DRAFT_SAVE_REQUEST);

        /** @var mixed $content */
        $content = $body['content'] ?? null;

        if (!\is_array($content)) {
            // Unreachable: the request schema requires `content` and the
            // validator returns the normalised document.
            throw HttpException::validationFailed('The save request carries no content object.');
        }

        /** @var array<string, mixed> $content */
        try {
            $envelope = $this->storage->saveDraft($this->expectedRevision($body), $content);
        } catch (DanglingMediaReferenceException $dangling) {
            // ESZ-147: the caller submitted a managed media src the catalogue
            // does not carry. Like any other document the caller sent, that is
            // the caller's 400 — checked under the shared media/content
            // boundary, so nothing was written and the head did not move.
            $this->logger->info(
                'Draft save refused: a managed media reference is not catalogued.',
                ['reason' => 'dangling-media-reference'],
            );

            throw HttpException::validationFailed($dangling->getMessage());
        }

        $this->logger->info('Draft saved.', ['revision' => $this->revisionOf($envelope)]);

        return Response::json(
            200,
            $envelope,
            $this->contentHeaders($this->revisionOf($envelope)),
        );
    }
}
