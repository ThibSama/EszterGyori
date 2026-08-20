<?php

declare(strict_types=1);

namespace Eszter\Http;

/**
 * A failure that maps directly onto one frozen error envelope.
 *
 * `$code` is an {@see ErrorCatalog} constant; the message is never carried here,
 * because the contract owns the copy.
 */
final class HttpException extends \RuntimeException
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        public readonly array $headers = [],
        string $logMessage = '',
    ) {
        parent::__construct($logMessage !== '' ? $logMessage : $errorCode);
    }

    /** @param list<string> $allowed */
    public static function methodNotAllowed(array $allowed): self
    {
        return new self(
            405,
            ErrorCatalog::METHOD_NOT_ALLOWED,
            ['Allow' => implode(', ', $allowed)],
        );
    }

    public static function notFound(): self
    {
        return new self(404, ErrorCatalog::NOT_FOUND);
    }

    public static function invalidJson(string $logMessage = ''): self
    {
        return new self(400, ErrorCatalog::INVALID_JSON, [], $logMessage);
    }

    /**
     * A body that parsed as JSON but is not the shape the endpoint accepts.
     *
     * Distinct from {@see invalidJson()} because the two are distinct problems for
     * the caller: one means "your bytes are not JSON", the other "your JSON is not
     * this request". `$logMessage` goes to the log only — the response body is the
     * frozen envelope, so a field name never leaks through it.
     */
    public static function validationFailed(string $logMessage = ''): self
    {
        return new self(400, ErrorCatalog::VALIDATION_FAILED, [], $logMessage);
    }

    /**
     * The single login failure (`auth.loginFailure`).
     *
     * One factory, deliberately taking no argument that could vary the response.
     * Unknown address, wrong password and disabled account all come here, and the
     * contract requires them to be indistinguishable; the way to keep that true is
     * to make it impossible to express the difference. The reason is logged by the
     * caller, against the request id, and never carried on the exception.
     */
    public static function invalidCredentials(): self
    {
        return new self(401, ErrorCatalog::INVALID_CREDENTIALS);
    }

    public static function unauthenticated(): self
    {
        return new self(401, ErrorCatalog::UNAUTHENTICATED);
    }

    public static function csrfTokenInvalid(string $logMessage = ''): self
    {
        return new self(403, ErrorCatalog::CSRF_TOKEN_INVALID, [], $logMessage);
    }

    /**
     * An upload over the media route's own limit (ESZ-036).
     *
     * 413 rather than the 400 `overLimitBodyOutcome` gives an oversized JSON
     * body, because the two are different problems with different fixes. A
     * 65 kB save request means the client built something wrong; a 12 MB upload
     * means the person chose a file that is too big, and the only useful response
     * tells them so in a way their UI can turn into "choose a smaller image".
     */
    public static function payloadTooLarge(string $logMessage = ''): self
    {
        return new self(413, ErrorCatalog::PAYLOAD_TOO_LARGE, [], $logMessage);
    }

    /**
     * A delete refused because content still points at the asset (ESZ-037).
     *
     * 409, like a revision conflict, and deliberately *not* the same code. Both
     * mean "the state of something else forbids this", but the recoveries have
     * nothing in common: a revision conflict is fixed by re-reading and retrying,
     * and a client that retried this one would loop forever. The fix here is to
     * edit the content that uses the image.
     *
     * @param array<string, string> $headers
     */
    public static function mediaReferenced(array $headers = [], string $logMessage = ''): self
    {
        return new self(409, ErrorCatalog::MEDIA_REFERENCED, $headers, $logMessage);
    }
}
