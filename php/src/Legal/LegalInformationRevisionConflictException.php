<?php

declare(strict_types=1);

namespace Eszter\Legal;

/** A stale settings page tried to replace the legal document. */
final class LegalInformationRevisionConflictException extends \RuntimeException
{
    public function __construct(
        public readonly int $expectedRevision,
        public readonly int $currentRevision,
    ) {
        parent::__construct(\sprintf(
            'Expected legal information revision %d but the current revision is %d.',
            $expectedRevision,
            $currentRevision,
        ));
    }

    /** @return array<string, int> Safe for the log. */
    public function logContext(): array
    {
        return [
            'expectedRevision' => $this->expectedRevision,
            'currentRevision' => $this->currentRevision,
        ];
    }
}
