<?php

declare(strict_types=1);

namespace Eszter\Privacy;

/** A status change is outside the frozen received → in_progress → closed line. */
final class InvalidPrivacyRequestTransitionException extends \DomainException
{
    public function __construct(
        public readonly string $from,
        public readonly string $to,
    ) {
        parent::__construct("Privacy request status cannot transition from {$from} to {$to}.");
    }
}
