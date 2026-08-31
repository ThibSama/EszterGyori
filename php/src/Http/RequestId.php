<?php

declare(strict_types=1);

namespace Eszter\Http;

/**
 * Correlation id for one request.
 *
 * Frozen behaviour (`docs/contract-freeze.md`, "Request ids"): an inbound value
 * is echoed **only** if it matches the safe pattern, otherwise it is replaced by
 * a generated `req_<uuid>`. This is a header-injection guard, not a formatting
 * preference, and the contract says it must not be relaxed. The pattern itself is
 * read from `http-contract.json` so it cannot drift from the contract.
 */
final class RequestId
{
    public const HEADER = 'X-Request-Id';

    public function __construct(
        private readonly string $safePattern,
        private readonly string $generatedPrefix,
    ) {
    }

    /** @param array<mixed> $httpContract */
    public static function fromContract(array $httpContract): self
    {
        /** @var mixed $spec */
        $spec = $httpContract['requestId'] ?? null;

        if (
            !\is_array($spec)
            || !\is_string($spec['trustedInboundPattern'] ?? null)
            || !\is_string($spec['generatedPrefix'] ?? null)
        ) {
            throw new \RuntimeException('http-contract.json has no usable requestId specification.');
        }

        return new self($spec['trustedInboundPattern'], $spec['generatedPrefix']);
    }

    public function isTrusted(string $value): bool
    {
        // The contract states the pattern as an ECMA-262 regex. It uses no
        // constructs whose meaning differs under PCRE, so delimiting is enough.
        return preg_match('#' . str_replace('#', '\\#', $this->safePattern) . '#', $value) === 1;
    }

    public function resolve(?string $inbound): string
    {
        if ($inbound !== null && $this->isTrusted($inbound)) {
            return $inbound;
        }

        return $this->generate();
    }

    public function generate(): string
    {
        return $this->generatedPrefix . self::uuidV4();
    }

    private static function uuidV4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = \chr((\ord($bytes[6]) & 0x0F) | 0x40);
        $bytes[8] = \chr((\ord($bytes[8]) & 0x3F) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
