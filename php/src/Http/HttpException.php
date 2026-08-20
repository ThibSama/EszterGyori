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
}
