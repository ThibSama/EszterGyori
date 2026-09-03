<?php

declare(strict_types=1);

namespace Eszter\Media;

use Eszter\Contract\StructuralValidator;
use Eszter\Storage\StorageException;
use Eszter\Support\Clock;
use Eszter\Support\Logger;

/**
 * The upload pipeline (ESZ-036), in the order `mediaIngest.pipeline` freezes.
 *
 * Authentication and the CSRF check are the endpoint's; everything from
 * "bound the bytes" onwards is here. The order is the specification and each step
 * exists because the one before it is insufficient on its own — the contract's
 * `mediaIngest` doc comment argues each of them, and this class is that argument
 * executed.
 *
 * ## What never influences the outcome
 *
 * The part's declared `Content-Type` and its filename. Both are carried on
 * {@see UploadedFile} so a log line can report what was claimed, and neither is
 * read by any branch below. That is what makes `evil.php`, `photo.jpg.php`,
 * `../../../etc/passwd` and `image/jpeg`-on-a-shell-script all identical inputs
 * to this class: it never asks.
 *
 * ## Cleanup
 *
 * Every path out of {@see ingest()} that is not a success removes the intake file
 * and the staging file. Not "most paths" — the `finally` covers the successful
 * one too, where both have already been renamed away and the unlinks are no-ops.
 * A cleanup that has to be remembered per branch is a cleanup that will be
 * forgotten on the branch added next year.
 */
final class MediaIngest
{
    /**
     * The one mode an intake file may carry (ESZ-103): the caller's unverified
     * bytes are private to the application user until they are verified, at
     * 0600 like PHP's own upload temp files (the explicit restriction is what
     * keeps that true for a copy-based transport or a future host).
     */
    public const INTAKE_MODE = 0o600;

    /**
     * @param \Closure(string, int): bool|null $setFileMode Narrowest test seam
     *        for the intake mode restriction: when provided it replaces **only**
     *        the `chmod(2)` call. Production passes null and gets the real
     *        chmod. The effective-mode verification that follows is never
     *        seam-injectable — an intake file is only accepted when
     *        `fileperms()` shows {@see INTAKE_MODE} — so a seam can force a
     *        refusal but cannot make an unverified restriction look applied.
     */
    public function __construct(
        private readonly MediaContract $contract,
        private readonly ImagePipeline $images,
        private readonly MediaLibrary $library,
        private readonly StructuralValidator $structural,
        private readonly UploadTransport $transport,
        private readonly Clock $clock,
        private readonly Logger $logger,
        private readonly ?\Closure $setFileMode = null,
    ) {
    }

    /**
     * Verifies and stores exactly one uploaded image.
     *
     * @param list<UploadedFile> $uploads Every part the request carried.
     * @return array<string, mixed> The catalogued metadata.
     * @throws MediaConfigurationException The host cannot verify an image.
     * @throws MediaUploadHostFaultException PHP could not take the upload.
     * @throws MediaException The upload is unacceptable.
     * @throws StorageException Storing what was verified failed.
     */
    public function ingest(array $uploads): array
    {
        // Before a byte is touched: a host that cannot decode is a host that
        // cannot verify, and accepting on magic bytes alone is not the pipeline
        // the contract froze.
        $this->images->assertAvailable();

        $upload = $this->soleUpload($uploads);
        $this->assertUploadSucceeded($upload);

        $this->library->ensureDirectories();
        $intakePath = $this->library->newIntakePath();
        $stagingPath = null;

        try {
            $this->moveIntoIntake($upload, $intakePath);

            // Re-measured from the file rather than trusted from `$_FILES`,
            // whose `size` is what the parser counted and not necessarily what
            // survived onto disk.
            $bytes = @filesize($intakePath);

            if ($bytes === false || $bytes <= 0) {
                throw MediaException::rejected('The uploaded part is empty on disk.');
            }

            if ($bytes > $this->contract->uploadLimitBytes) {
                throw MediaException::tooLarge(
                    "The uploaded file is {$bytes} bytes, over the "
                    . $this->contract->uploadLimitBytes . ' byte limit.',
                );
            }

            $mimeType = $this->verifiedType($intakePath, $upload);
            $header = $this->boundedHeader($intakePath, $mimeType);

            // Before the decode, because the decode is what cannot answer this:
            // a truncated JPEG comes back from libjpeg as a complete image with
            // grey filler and no complaint at all.
            if (!$this->images->isStreamComplete($intakePath, $mimeType)) {
                throw MediaException::rejected(
                    "A file typed as {$mimeType} does not carry its end-of-stream marker.",
                );
            }

            $id = $this->contract->newAssetId();
            $stagingPath = $this->library->newStagingPath();
            $stored = $this->images->reencode($intakePath, $mimeType, $stagingPath);

            $derivativeBytes = @filesize($stagingPath);

            if ($derivativeBytes === false || $derivativeBytes <= 0) {
                throw MediaException::rejected('Re-encoding produced no bytes.');
            }

            $metadata = $this->metadataFor($id, $mimeType, $derivativeBytes, $stored);

            $catalogued = $this->library->publishAsset($id, $intakePath, $stagingPath, $metadata);

            $this->logger->info('Media asset stored.', [
                'id' => $id,
                'mimeType' => $mimeType,
                'byteSize' => $derivativeBytes,
                // What the caller *said*, recorded once and used nowhere. Useful
                // when someone asks why their upload was refused; never a input.
                'declaredMimeType' => $upload->declaredMimeType,
                'uploadedBytes' => $bytes,
                'sourceWidth' => $header['width'],
                'sourceHeight' => $header['height'],
            ]);

            return $catalogued;
        } finally {
            // No-ops on the success path, where both have been renamed away.
            @unlink($intakePath);

            if ($stagingPath !== null) {
                @unlink($stagingPath);
            }
        }
    }

    /**
     * Exactly one part, under exactly the contracted field name.
     *
     * Refusing extra parts is not fussiness. An endpoint that picks the part it
     * recognises and ignores the rest is an endpoint whose behaviour changes the
     * day someone adds a field, and one whose limits apply to the part it looked
     * at rather than to what was sent.
     *
     * @param list<UploadedFile> $uploads
     */
    private function soleUpload(array $uploads): UploadedFile
    {
        if ($uploads === []) {
            throw MediaException::noFile('The request carried no file part.');
        }

        if (\count($uploads) > 1) {
            throw MediaException::rejected(
                'The request carried ' . \count($uploads) . ' file parts; exactly one is accepted.',
            );
        }

        $upload = $uploads[0];

        if ($upload->fieldName !== $this->contract->uploadFieldName) {
            throw MediaException::rejected(
                "The file part is named {$upload->fieldName}; only "
                . $this->contract->uploadFieldName . ' is accepted.',
            );
        }

        return $upload;
    }

    /**
     * Turns PHP's upload error code into the right outcome (ESZ-135).
     *
     * The classification is frozen, code by code:
     *
     * - `UPLOAD_ERR_OK`: continue;
     * - `UPLOAD_ERR_INI_SIZE`, `UPLOAD_ERR_FORM_SIZE`: 413 `PAYLOAD_TOO_LARGE` —
     *   the file was too big, which is a different thing for the person holding
     *   it than "your file was not acceptable", whatever measured it;
     * - `UPLOAD_ERR_NO_FILE`, `UPLOAD_ERR_PARTIAL`: 400 — the part carried no
     *   file, or the transfer was truncated and the bytes that arrived are not
     *   an image, whatever the ones that did not would have been;
     * - `UPLOAD_ERR_NO_TMP_DIR`, `UPLOAD_ERR_CANT_WRITE`, `UPLOAD_ERR_EXTENSION`:
     *   host faults. PHP could not even take the upload — no usable temporary
     *   directory, no write, an extension abort. Telling the caller their input
     *   failed validation would be a lie about which side broke, so these are
     *   {@see MediaUploadHostFaultException}, which the endpoint answers with the
     *   opaque generic 500 and logs at error level;
     * - any other non-zero code: fail closed the same way. Nothing in the frozen
     *   classification makes an unknown code the caller's fault, so the honest
     *   default is the server's failure, never `VALIDATION_FAILED`.
     */
    private function assertUploadSucceeded(UploadedFile $upload): void
    {
        switch ($upload->errorCode) {
            case \UPLOAD_ERR_OK:
                return;

            case \UPLOAD_ERR_INI_SIZE:
            case \UPLOAD_ERR_FORM_SIZE:
                throw MediaException::tooLarge(
                    'PHP refused the upload as over its own size limit (code '
                    . $upload->errorCode . '). Check upload_max_filesize and post_max_size.',
                );

            case \UPLOAD_ERR_NO_FILE:
                throw MediaException::noFile('The file part carried no file.');

            case \UPLOAD_ERR_PARTIAL:
                throw MediaException::rejected('The upload arrived truncated.');

            case \UPLOAD_ERR_NO_TMP_DIR:
                throw MediaUploadHostFaultException::noTmpDir();

            case \UPLOAD_ERR_CANT_WRITE:
                throw MediaUploadHostFaultException::cantWrite();

            case \UPLOAD_ERR_EXTENSION:
                throw MediaUploadHostFaultException::extensionAborted();

            default:
                throw MediaUploadHostFaultException::unknownCode($upload->errorCode);
        }
    }

    /**
     * Moves the part out of PHP's temp area into intake.
     *
     * {@see UploadTransport::isUploadedFile()} is what makes this safe: it answers
     * only for paths PHP wrote while parsing *this* request, so a `$_FILES` entry
     * pointing at `/etc/passwd` is refused here rather than read.
     */
    private function moveIntoIntake(UploadedFile $upload, string $intakePath): void
    {
        if (!$this->transport->isUploadedFile($upload->temporaryPath)) {
            throw MediaException::rejected(
                'The named temporary file is not an upload from this request.',
            );
        }

        if (!$this->transport->moveUploadedFile($upload->temporaryPath, $intakePath)) {
            throw new StorageException(
                StorageException::WRITE_FAILED,
                "Could not move the uploaded part into {$intakePath}.",
                MediaLibrary::METADATA_ROLE,
            );
        }

        // The intake file is the caller's unverified bytes and must not be
        // readable by group or others. The restriction is verified, not assumed;
        // when it cannot be established the ingest stops here and the `finally`
        // removes the intake file, so an unrestricted upload is never verified,
        // stored or catalogued.
        if (!$this->restrictTo($intakePath, self::INTAKE_MODE)) {
            throw new StorageException(
                StorageException::WRITE_FAILED,
                \sprintf(
                    'Could not restrict the intake file %s to mode %04o.',
                    $intakePath,
                    self::INTAKE_MODE,
                ),
                MediaLibrary::METADATA_ROLE,
            );
        }
    }

    /**
     * Applies $mode to $path and verifies the effective mode.
     *
     * A `chmod` call alone is not proof that the restriction took effect; the
     * restriction only counts when `fileperms()` shows the requested mode.
     */
    private function restrictTo(string $path, int $mode): bool
    {
        $applied = $this->setFileMode === null
            ? @chmod($path, $mode)
            : ($this->setFileMode)($path, $mode);

        if ($applied !== true) {
            return false;
        }

        $actual = @fileperms($path);

        return $actual !== false && ($actual & 0o777) === $mode;
    }

    /**
     * The media type, decided by the bytes and confirmed against the allowlist.
     */
    private function verifiedType(string $intakePath, UploadedFile $upload): string
    {
        $detected = $this->images->detectMimeType($intakePath);

        if ($detected === null) {
            throw MediaException::rejected('The uploaded bytes could not be typed.');
        }

        if (!$this->contract->accepts($detected)) {
            // Logged with both, so a refusal that surprises someone can be
            // explained without asking them to re-upload. The comparison above
            // used only the first of the two.
            $this->logger->warn('Media upload refused: type not on the allowlist.', [
                'detected' => $detected,
                'declared' => $upload->declaredMimeType,
            ]);

            throw MediaException::rejected("Detected media type {$detected} is not accepted.");
        }

        return $detected;
    }

    /**
     * Header dimensions, checked for agreement and for size before any decode.
     *
     * The type comparison is the polyglot check: `finfo` read magic bytes and
     * `getimagesize()` parsed an image header, and a file that answers those two
     * parsers differently is two files at once. Refusing it is the only safe
     * resolution — picking one of the answers means the *other* parser's view is
     * what a downstream consumer might act on.
     *
     * @return array{width: int, height: int, mimeType: string}
     */
    private function boundedHeader(string $intakePath, string $mimeType): array
    {
        $header = $this->images->inspect($intakePath);

        if ($header === null) {
            throw MediaException::rejected('The uploaded bytes carry no readable image header.');
        }

        if ($header['mimeType'] !== $mimeType) {
            throw MediaException::rejected(\sprintf(
                'Magic bytes report %s and the image header reports %s.',
                $mimeType,
                $header['mimeType'],
            ));
        }

        if (!$this->images->isWithinBounds($header)) {
            throw MediaException::rejected(\sprintf(
                'Image dimensions %dx%d are outside the accepted bounds.',
                $header['width'],
                $header['height'],
            ));
        }

        return $header;
    }

    /**
     * The metadata row, validated against the frozen schema before it is stored.
     *
     * Validating here rather than only inside the library is the same split the
     * content surface makes: a row this class builds and cannot validate is a
     * fault in this class, and it is better to find it before two files have been
     * renamed into place than after.
     *
     * @param array{width: int, height: int} $stored
     * @return array{
     *     id: string,
     *     path: string,
     *     mimeType: string,
     *     byteSize: int,
     *     width: int,
     *     height: int,
     *     uploadedAt: string,
     * }
     */
    private function metadataFor(string $id, string $mimeType, int $byteSize, array $stored): array
    {
        $metadata = [
            'id' => $id,
            'path' => $this->contract->publicPathFor($id, $mimeType),
            'mimeType' => $mimeType,
            'byteSize' => $byteSize,
            'width' => $stored['width'],
            'height' => $stored['height'],
            'uploadedAt' => $this->clock->nowIso(),
        ];

        $issues = $this->structural->validate(
            ['schemaVersion' => $this->library->schemaVersion(), 'assets' => [$metadata]],
            MediaLibrary::INDEX_SCHEMA,
        );

        if ($issues !== []) {
            throw new StorageException(
                StorageException::VALIDATION_FAILED,
                'Generated media metadata failed contract validation: ' . \count($issues) . ' issue(s).',
                MediaLibrary::METADATA_ROLE,
            );
        }

        return $metadata;
    }
}
