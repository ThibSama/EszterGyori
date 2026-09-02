<?php

declare(strict_types=1);

namespace Eszter\Retention;

use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;

/**
 * The frozen ESZ-140 V1 customer-data retention policy, consumed rather than
 * restated.
 *
 * Every bound, placeholder and code here comes from the `customerDataRetention`
 * block of `booking-domain.json`. Nothing in the retention path declares one of
 * its own: the migration's CHECK constraint restates the same placeholders
 * where SQL can enforce them, and `RetentionSchemaTest` fails if the artifact,
 * this class and the schema ever disagree.
 *
 * The policy is a product policy of this application, not a claim about any
 * statute — that distinction is recorded in the contract's own `scope` text.
 */
final class RetentionPolicy
{
    private function __construct(
        public readonly int $confirmedExpiryDaysAfterEndsAtUtc,
        public readonly int $cancelledExpiryDaysAfterCancelledAtUtc,
        public readonly int $backupArchiveRetentionDays,
        public readonly string $erasedCustomerName,
        public readonly string $erasedCustomerEmail,
        public readonly string $erasureJobCode,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        $document = $artifacts->load('booking-domain.json');
        $retention = self::block($document, 'customerDataRetention');
        $erasedFields = self::block($retention, 'erasedFields');

        return new self(
            self::positiveInt($retention, 'confirmedExpiryDaysAfterEndsAtUtc'),
            self::positiveInt($retention, 'cancelledExpiryDaysAfterCancelledAtUtc'),
            self::positiveInt($retention, 'backupArchiveRetentionDays'),
            self::string($erasedFields, 'customerName'),
            self::string($erasedFields, 'customerEmail'),
            self::string($retention, 'erasureJobCode'),
        );
    }

    /**
     * The placeholder e-mail is frozen to a domain reserved by RFC 2606
     * (`example.invalid`), which no mail system routes. The guarantee is not
     * that nothing will try to deliver to it — the facts provider refuses
     * erased bookings outright — but that nothing can succeed.
     */
    public function isErasureCode(string $code): bool
    {
        return $code === $this->erasureJobCode;
    }

    /**
     * @param array<mixed> $source
     * @return array<mixed>
     */
    private static function block(array $source, string $key): array
    {
        $value = $source[$key] ?? null;

        if (!\is_array($value)) {
            throw new ContractArtifactException("booking-domain.json has no `{$key}` retention block.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function string(array $source, string $key): string
    {
        $value = $source[$key] ?? null;

        if (!\is_string($value) || $value === '') {
            throw new ContractArtifactException("booking-domain.json has no non-empty `{$key}` string.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function positiveInt(array $source, string $key): int
    {
        $value = $source[$key] ?? null;

        if (!\is_int($value) || $value <= 0) {
            throw new ContractArtifactException("booking-domain.json has no positive `{$key}` integer.");
        }

        return $value;
    }
}
