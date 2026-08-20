<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaLibrary;
use Eszter\Media\MediaMissingException;
use Eszter\Media\MediaReferencedException;
use Eszter\Media\MediaReferences;
use Eszter\Storage\ContentStorage;
use Eszter\Storage\StorageException;
use Eszter\Support\Logger;

/**
 * `DELETE /api/admin/media` (ESZ-037).
 *
 * The id travels in the body; `mediaDeleteRequestSchema` argues why. The schema
 * is closed and its pattern admits no separator and no dot, so a value that
 * reaches the library has already been proved incapable of expressing a path.
 *
 * ## The reference check is the point of this endpoint
 *
 * An asset is deletable only when **neither** the authoritative draft **nor** the
 * published document points at it. Both, because they can differ: an image
 * removed from the draft is still on the live site until someone publishes, and
 * deleting it then would break the public page for every visitor while the CMS
 * showed nothing wrong. Checking only the published side is the mirror mistake —
 * it would let an editor delete the photograph their unsaved layout depends on.
 *
 * The check runs **inside** the library's exclusive lock, as a closure the library
 * calls, so no upload or delete can interleave with it. What it cannot exclude is
 * a *content* save landing between the check and the removal, because that write
 * takes a different lock; the consequence is a draft holding one dangling path,
 * which the editor sees as a broken preview and fixes by repointing the field. A
 * single lock over both would close it, at the cost of making every draft save
 * wait behind media operations — the wrong trade for a race that needs two people
 * editing the same asset in the same instant.
 *
 * ## Reading content here does not make this a content route
 *
 * It reads `draft.json` and `published.json` and writes neither. Both revisions
 * are untouched, no `x-content-revision` is sent, and a 204 from here changes
 * nothing about what `/` or `/api/content` serve.
 */
final class AdminMediaDeleteEndpoint extends AdminMediaEndpoint
{
    public const REQUEST_SCHEMA = 'media-delete-request.schema.json';

    public function __construct(
        Authenticator $auth,
        SessionManager $sessions,
        CsrfGuard $csrf,
        MediaContract $contract,
        MediaLibrary $library,
        StructuralValidator $structural,
        Logger $logger,
        private readonly ContentStorage $storage,
    ) {
        parent::__construct($auth, $sessions, $csrf, $contract, $library, $structural, $logger);
    }

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, self::REQUEST_SCHEMA);

        /** @var mixed $id */
        $id = $body['id'] ?? null;

        if (!\is_string($id)) {
            // Unreachable: the schema requires a string matching the id pattern.
            throw HttpException::validationFailed('The delete request carries no id.');
        }

        try {
            $removed = $this->library->deleteAsset(
                $id,
                fn (string $publicPath): bool => $this->isReferenced($publicPath),
            );
        } catch (MediaMissingException $missing) {
            // Well-formed and unknown. A *malformed* id never gets here — the
            // request schema refused it above — which is what keeps the frozen
            // pattern load-bearing rather than something a later sanitiser does.
            $this->logger->info('Media delete refused: no such asset.', ['id' => $id]);

            throw new HttpException(
                404,
                ErrorCatalog::NOT_FOUND,
                $this->mediaHeaders(),
                $missing->getMessage(),
            );
        } catch (MediaReferencedException $referenced) {
            $this->logger->info('Media delete refused: the asset is still in use.', ['id' => $id]);

            throw HttpException::mediaReferenced(
                $this->mediaHeaders(),
                $referenced->getMessage(),
            );
        }

        $this->logger->info('Media asset deleted.', ['id' => $removed['id'] ?? $id]);

        return Response::empty(204, $this->mediaHeaders());
    }

    /**
     * Whether either content document points at $publicPath.
     *
     * A document that cannot be read is *not* treated as holding no references.
     * The storage exception propagates and the request answers the opaque 500,
     * because "the draft is unreadable" and "the draft does not use this image"
     * are different facts and only one of them makes a delete safe.
     */
    private function isReferenced(string $publicPath): bool
    {
        foreach ([$this->storage->readDraft(), $this->storage->readPublished()] as $envelope) {
            /** @var mixed $content */
            $content = $envelope['content'] ?? null;

            if (!\is_array($content)) {
                // readEnvelope() validated against a schema requiring `content`,
                // so this cannot happen — and if it somehow did, answering "not
                // referenced" would be the one wrong answer.
                throw new StorageException(
                    StorageException::VALIDATION_FAILED,
                    'A stored envelope carries no content object to scan for media references.',
                );
            }

            if (MediaReferences::isReferenced($content, $publicPath)) {
                return true;
            }
        }

        return false;
    }
}
