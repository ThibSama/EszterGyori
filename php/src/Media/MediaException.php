<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * A media operation failed for a reason the caller can be told about.
 *
 * Distinct from {@see \Eszter\Storage\StorageException}, which means the service
 * is broken, distinct from {@see MediaConfigurationException}, which means the
 * host cannot verify an image, and distinct from
 * {@see MediaUploadHostFaultException}, which means PHP itself could not take the
 * upload (no temporary directory, no write, an extension abort). This one means
 * the *upload* was unacceptable, and the endpoint turns it into a 400 or a 413.
 *
 * The message names what was wrong in enough detail to be useful in a log and is
 * never put on the wire: the response carries the frozen envelope, whose copy the
 * contract owns. That is the same rule every other layer follows, and it matters
 * more here — a message like "finfo reported application/x-dosexec" tells a
 * prober exactly which check it has to get past next.
 */
final class MediaException extends \RuntimeException
{
    /** The bytes are not something this site accepts. 400 VALIDATION_FAILED. */
    public const REJECTED = 'MEDIA_REJECTED';

    /** The upload is over the route's own limit. 413 PAYLOAD_TOO_LARGE. */
    public const TOO_LARGE = 'MEDIA_TOO_LARGE';

    /** The request carried no usable file part at all. 400 VALIDATION_FAILED. */
    public const NO_FILE = 'MEDIA_NO_FILE';

    public function __construct(
        public readonly string $mediaCode,
        string $message,
    ) {
        parent::__construct($message);
    }

    public static function rejected(string $message): self
    {
        return new self(self::REJECTED, $message);
    }

    public static function tooLarge(string $message): self
    {
        return new self(self::TOO_LARGE, $message);
    }

    public static function noFile(string $message): self
    {
        return new self(self::NO_FILE, $message);
    }

    /** @return array<string, string> Safe for the log, never for a response. */
    public function logContext(): array
    {
        return ['code' => $this->mediaCode];
    }
}
