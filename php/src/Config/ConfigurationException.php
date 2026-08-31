<?php

declare(strict_types=1);

namespace Eszter\Config;

/**
 * Configuration is invalid or unreadable.
 *
 * Always fatal. `docs/hetzner-target-architecture.md` §9 is explicit: a
 * half-configured site must never be served. The HTTP layer turns this into a
 * 500 `INVALID_CONFIGURATION` envelope; the detail stays in the log.
 *
 * @phpstan-type Issue array{path: string, message: string}
 */
final class ConfigurationException extends \RuntimeException
{
    /** @param list<array{path: string, message: string}> $issues */
    public function __construct(string $message, private readonly array $issues = [])
    {
        parent::__construct($message);
    }

    /** @return list<array{path: string, message: string}> */
    public function issues(): array
    {
        return $this->issues;
    }

    /** @param list<array{path: string, message: string}> $issues */
    public static function invalid(array $issues): self
    {
        $summary = implode('; ', array_map(
            static fn (array $issue): string => "{$issue['path']}: {$issue['message']}",
            $issues,
        ));

        return new self("Invalid configuration: {$summary}", $issues);
    }
}
