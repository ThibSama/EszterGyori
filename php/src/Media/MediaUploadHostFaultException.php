<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * PHP itself could not take the upload, for a host reason.
 *
 * Raised when the upload error code says the machine failed, not the caller:
 * `UPLOAD_ERR_NO_TMP_DIR` (no usable temporary directory), `UPLOAD_ERR_CANT_WRITE`
 * (the bytes could not be written to disk) and `UPLOAD_ERR_EXTENSION` (an
 * extension stopped the upload). An unrecognised non-zero code fails closed the
 * same way — nothing in the frozen classification says an unknown code is the
 * caller's fault, so it is treated as the server's.
 *
 * Distinct from {@see MediaException}, which means the *upload* was unacceptable
 * and is the caller's to fix, and from {@see MediaConfigurationException}, which
 * means the host cannot *verify* an image. This one is deliberately not either:
 * a missing temporary directory or an unwritable destination is not an
 * image-verification configuration, and telling the caller their input failed
 * validation for a failure that happened before their input was read would be a
 * lie about which side broke.
 *
 * The message is log-only, like every other exception message in this layer,
 * and never reaches a response: the endpoint answers the frozen generic 500
 * envelope and puts the classification here in the operator log, where it may
 * name the PHP upload error code but no client-supplied path or temporary name.
 */
final class MediaUploadHostFaultException extends \RuntimeException
{
    /**
     * The stable internal classification, for logs and never for a response.
     */
    public const CLASSIFICATION = 'PHP_UPLOAD_HOST_FAULT';

    public function __construct(
        public readonly int $phpErrorCode,
        string $message,
    ) {
        parent::__construct($message);
    }

    public static function noTmpDir(): self
    {
        return new self(
            \UPLOAD_ERR_NO_TMP_DIR,
            'PHP could not store the upload: no usable temporary directory.',
        );
    }

    public static function cantWrite(): self
    {
        return new self(
            \UPLOAD_ERR_CANT_WRITE,
            'PHP could not write the uploaded part to disk.',
        );
    }

    public static function extensionAborted(): self
    {
        return new self(
            \UPLOAD_ERR_EXTENSION,
            'A PHP extension stopped the upload before it completed.',
        );
    }

    /** Fail-closed classification for any non-zero code the switch does not know. */
    public static function unknownCode(int $phpErrorCode): self
    {
        return new self(
            $phpErrorCode,
            "PHP reported an unrecognised upload error code ({$phpErrorCode}).",
        );
    }

    /** @return array<string, string|int> Safe for the log, never for a response. */
    public function logContext(): array
    {
        return [
            'classification' => self::CLASSIFICATION,
            'phpErrorCode' => $this->phpErrorCode,
        ];
    }
}
