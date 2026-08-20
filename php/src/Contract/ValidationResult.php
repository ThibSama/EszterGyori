<?php

declare(strict_types=1);

namespace Eszter\Contract;

/**
 * Outcome of validating one document.
 *
 * On success `value` carries the *normalised* document — uppercased hex colours
 * and injected appearance defaults — mirroring what Zod's `.transform` and
 * `.default` produce. Callers must use `value`, never the input they passed in,
 * or the two implementations diverge on output.
 */
final class ValidationResult
{
    /** @param list<ValidationIssue> $issues */
    private function __construct(
        public readonly bool $valid,
        public readonly array $issues,
        public readonly mixed $value = null,
    ) {
    }

    public static function ok(mixed $value): self
    {
        return new self(true, [], $value);
    }

    /** @param list<ValidationIssue> $issues */
    public static function failed(array $issues): self
    {
        if ($issues === []) {
            throw new \LogicException('A failed ValidationResult must carry at least one issue.');
        }

        return new self(false, $issues);
    }

    /** @return list<string> */
    public function issuePaths(): array
    {
        return array_map(static fn (ValidationIssue $issue): string => $issue->path, $this->issues);
    }

    public function summary(): string
    {
        return implode('; ', array_map(
            static fn (ValidationIssue $issue): string => ($issue->path === '' ? '<root>' : $issue->path)
                . ' ' . $issue->message,
            $this->issues,
        ));
    }
}
