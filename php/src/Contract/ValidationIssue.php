<?php

declare(strict_types=1);

namespace Eszter\Contract;

/**
 * One rejection, addressed by JSON Pointer.
 *
 * `path` is what the parity corpus compares — `expectedIssuePaths` is asserted
 * exactly, so the pointer is contractual and the message is not.
 * `rule` names the semantic-rules.json entry that produced it, or null for a
 * structural (JSON Schema) rejection.
 */
final class ValidationIssue
{
    public function __construct(
        public readonly string $path,
        public readonly string $message,
        public readonly ?string $rule = null,
    ) {
    }

    /** @return array{path: string, message: string, rule: string|null} */
    public function toArray(): array
    {
        return ['path' => $this->path, 'message' => $this->message, 'rule' => $this->rule];
    }
}
