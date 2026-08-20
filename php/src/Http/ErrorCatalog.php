<?php

declare(strict_types=1);

namespace Eszter\Http;

use Eszter\Contract\ContractArtifacts;

/**
 * The frozen error codes and their French messages, read from
 * `http-contract.json`.
 *
 * The copy is deliberately not retyped here. `docs/contract-freeze.md`: "The
 * French user-facing messages are part of the contract (`apiErrorMessages`) so
 * the frontend and a PHP implementation cannot diverge on copy." A hard-coded
 * string in PHP is exactly the divergence that document exists to prevent.
 */
final class ErrorCatalog
{
    public const NOT_FOUND = 'NOT_FOUND';
    public const METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED';
    public const INVALID_JSON = 'INVALID_JSON';
    public const VALIDATION_FAILED = 'VALIDATION_FAILED';
    public const INVALID_CREDENTIALS = 'INVALID_CREDENTIALS';
    public const UNAUTHENTICATED = 'UNAUTHENTICATED';
    public const CSRF_TOKEN_INVALID = 'CSRF_TOKEN_INVALID';
    public const REVISION_CONFLICT = 'REVISION_CONFLICT';
    public const INVALID_CONFIGURATION = 'INVALID_CONFIGURATION';
    public const STORAGE_FAILURE = 'STORAGE_FAILURE';
    public const INTERNAL_ERROR = 'INTERNAL_ERROR';

    /** @param array<string, string> $messages */
    private function __construct(private readonly array $messages)
    {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        $contract = $artifacts->httpContract();
        /** @var mixed $codes */
        $codes = $contract['errorCodes'] ?? null;
        /** @var mixed $messages */
        $messages = $contract['errorMessages'] ?? null;

        if (!\is_array($codes) || !\is_array($messages)) {
            throw new \RuntimeException('http-contract.json has no errorCodes/errorMessages.');
        }

        $resolved = [];
        foreach ($codes as $code) {
            if (!\is_string($code) || !\is_string($messages[$code] ?? null)) {
                throw new \RuntimeException('http-contract.json declares a code with no message.');
            }
            $resolved[$code] = $messages[$code];
        }

        return new self($resolved);
    }

    public function message(string $code): string
    {
        if (!isset($this->messages[$code])) {
            throw new \InvalidArgumentException("Unknown error code: {$code}");
        }

        return $this->messages[$code];
    }

    /** @return list<string> */
    public function codes(): array
    {
        return array_keys($this->messages);
    }

    /**
     * The closed error envelope: exactly `error.{code,message,requestId}`, no
     * extra keys at either level.
     *
     * @return array{error: array{code: string, message: string, requestId: string}}
     */
    public function envelope(string $code, string $requestId): array
    {
        return [
            'error' => [
                'code' => $code,
                'message' => $this->message($code),
                'requestId' => $requestId,
            ],
        ];
    }
}
