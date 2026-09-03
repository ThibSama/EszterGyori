<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Media\MediaConfigurationException;
use Eszter\Media\MediaException;
use Eszter\Media\MediaIngest;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaLibrary;
use Eszter\Media\MediaUploadHostFaultException;
use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;
use Eszter\Contract\StructuralValidator;
use Eszter\Storage\StorageException;
use Eszter\Support\Logger;

/**
 * `POST /api/admin/media` (ESZ-036).
 *
 * A `multipart/form-data` request carrying exactly one part named `file`. The
 * verification is {@see MediaIngest}'s; this class is the translation layer
 * between its refusals and the frozen error envelope, plus one detection that
 * cannot live anywhere else.
 *
 * ## The silent `post_max_size` overflow
 *
 * When a request body exceeds `post_max_size`, PHP does not report an error. It
 * discards the body, leaves `$_POST` and `$_FILES` empty, and hands the script a
 * request that looks exactly like one where the user forgot to attach a file. The
 * two need opposite answers — "your file is too big" and "you sent no file" — so
 * the difference has to be recovered from the only evidence left: the request
 * declared a multipart body of non-zero length and no part arrived.
 *
 * That is a host-configuration problem as much as a caller problem, so it is
 * logged with the two ini values that decide it. `php/README.md` documents the
 * minimums a deployment must set.
 *
 * ## 201, and what it does not touch
 *
 * The response is 201 with the stored asset's metadata: something now exists that
 * did not. It changes no content — `draft.json` and `published.json` are not
 * opened — because uploading an image and *using* it are separate acts, and
 * conflating them would mean an upload silently rewrote the page.
 */
final class AdminMediaUploadEndpoint extends AdminMediaEndpoint
{
    public function __construct(
        Authenticator $auth,
        SessionManager $sessions,
        CsrfGuard $csrf,
        MediaContract $contract,
        MediaLibrary $library,
        StructuralValidator $structural,
        Logger $logger,
        private readonly MediaIngest $ingest,
    ) {
        parent::__construct($auth, $sessions, $csrf, $contract, $library, $structural, $logger);
    }

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $this->assertBodySurvivedThePhpLimits($request);

        try {
            $asset = $this->ingest->ingest($request->uploads);
        } catch (MediaConfigurationException $misconfigured) {
            // Not the caller's fault and not something to degrade around: a host
            // that cannot verify an image must refuse to store one.
            $this->logger->error('Media upload refused: the host cannot verify images.', [
                'detail' => $misconfigured->getMessage(),
            ]);

            throw new HttpException(
                500,
                ErrorCatalog::INVALID_CONFIGURATION,
                $this->mediaHeaders(),
                $misconfigured->getMessage(),
            );
        } catch (MediaUploadHostFaultException $hostFault) {
            // PHP itself could not take the upload — no temporary directory, no
            // write, an extension abort, or an unrecognised error code (ESZ-135).
            // That is an infrastructure failure, not bad input: the caller is
            // answered with the opaque generic 500, the classification and the
            // PHP upload error code go to the operator log at error level, and
            // neither the code nor any path reaches the response.
            $this->logger->error(
                'Media upload refused: the host could not take the upload.',
                $hostFault->logContext() + ['detail' => $hostFault->getMessage()],
            );

            throw new HttpException(
                500,
                ErrorCatalog::INTERNAL_ERROR,
                $this->mediaHeaders(),
                $hostFault->getMessage(),
            );
        } catch (StorageException $full) {
            if ($full->storageCode !== StorageException::FILE_TOO_LARGE) {
                // Every other storage failure keeps the opaque 500 the contract
                // freezes. Only the catalogue cap is the caller's to act on.
                throw $full;
            }

            // `storageLimits.overSizedMediaLibraryOutcome` (ESZ-084). The
            // catalogue is full, which is a fact about this site rather than
            // about this file — but 413 is still the honest class and the only
            // one the caller can act on, and the action is the same: delete
            // something. Nothing was stored: `publishAsset()` unlinks what it had
            // placed and the ingest unlinks the intake and staging files, so the
            // library is exactly as readable, and as deletable, as before.
            $this->logger->error('Media upload refused: the catalogue is at its size cap.', [
                'maxIndexBytes' => $this->library->maxIndexBytes(),
                'detail' => $full->getMessage(),
            ]);

            throw new HttpException(
                413,
                ErrorCatalog::PAYLOAD_TOO_LARGE,
                $this->mediaHeaders(),
                $full->getMessage(),
            );
        } catch (MediaException $rejected) {
            // The detail names types, sizes and decoder outcomes. It goes to the
            // log; the response is the frozen envelope, so a prober learns only
            // which of the two refusals it hit.
            $this->logger->warn('Media upload refused.', $rejected->logContext() + [
                'detail' => $rejected->getMessage(),
            ]);

            throw $rejected->mediaCode === MediaException::TOO_LARGE
                ? new HttpException(
                    413,
                    ErrorCatalog::PAYLOAD_TOO_LARGE,
                    $this->mediaHeaders(),
                    $rejected->getMessage(),
                )
                : new HttpException(
                    400,
                    ErrorCatalog::VALIDATION_FAILED,
                    $this->mediaHeaders(),
                    $rejected->getMessage(),
                );
        }

        return Response::json(201, ['asset' => $asset], $this->mediaHeaders());
    }

    /**
     * Distinguishes "no file attached" from "PHP threw the body away".
     *
     * Only reachable when no part arrived at all; a request that carried one is
     * the ingest's problem from here on.
     */
    private function assertBodySurvivedThePhpLimits(Request $request): void
    {
        if ($request->uploads !== []) {
            return;
        }

        $declared = $request->declaredContentLength();

        if (!$request->hasMultipartContentType() || $declared === null || $declared <= 0) {
            return;
        }

        $this->logger->warn('Media upload discarded before it reached the script.', [
            'declaredContentLength' => $declared,
            'post_max_size' => (string) ini_get('post_max_size'),
            'upload_max_filesize' => (string) ini_get('upload_max_filesize'),
        ]);

        throw HttpException::payloadTooLarge(
            "A multipart body of {$declared} bytes arrived with no parts, which is what PHP "
            . 'produces when post_max_size is exceeded.',
        );
    }
}
