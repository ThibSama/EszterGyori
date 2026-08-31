<?php

declare(strict_types=1);

namespace Eszter\Config;

/** Validated SMTP and customer-facing e-mail settings (ESZ-073). */
final class SmtpSettings
{
    public function __construct(
        public readonly string $host,
        public readonly int $port,
        public readonly string $encryption,
        public readonly bool $authenticationRequired,
        public readonly ?string $username,
        #[\SensitiveParameter]
        public readonly ?string $password,
        public readonly string $senderAddress,
        public readonly string $senderName,
        public readonly int $timeoutSeconds,
        public readonly string $customerContact,
        public readonly string $customerInstructions,
    ) {
    }
}
