<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * A stale back-office form tried to mutate a catalog row (ESZ-149).
 *
 * The service's `updatedAt` is its optimistic-concurrency token, exactly as a
 * booking's is (ESZ-139). The repository compares the caller's
 * `expectedUpdatedAt` byte-for-byte with the current row under the
 * authoritative row lock; a mismatch throws this before any write, so the
 * refusal leaves the row exactly as it was and the caller re-reads the catalog.
 */
final class BookableServiceRevisionConflictException extends \RuntimeException
{
    public function __construct(
        public readonly string $serviceKey,
        public readonly string $expectedUpdatedAt,
        public readonly string $currentUpdatedAt,
    ) {
        parent::__construct(\sprintf(
            'Expected service %s updatedAt %s but the current updatedAt is %s.',
            $serviceKey,
            $expectedUpdatedAt,
            $currentUpdatedAt,
        ));
    }

    /** @return array<string, string> Safe for the log. */
    public function logContext(): array
    {
        return [
            'serviceKey' => $this->serviceKey,
            'expectedUpdatedAt' => $this->expectedUpdatedAt,
            'currentUpdatedAt' => $this->currentUpdatedAt,
        ];
    }
}
