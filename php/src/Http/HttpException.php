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
}
