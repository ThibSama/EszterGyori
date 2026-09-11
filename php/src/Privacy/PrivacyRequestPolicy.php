<?php

declare(strict_types=1);

namespace Eszter\Privacy;

use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;

/**
 * The frozen ESZ-163 GDPR request register policy, consumed rather than
 * restated.
 *
 * Every type, status, transition, bound and period here comes from the
 * `privacyRequests` block of `booking-domain.json`. Nothing in the register
 * declares one of its own: the migration's CHECK constraints restate the
 * same enums where SQL can enforce them, and the wire schemas restate the
 * same lists where the structural validator can.
 */
final class PrivacyRequestPolicy
{
    /**
     * @param list<string> $types
     * @param list<string> $statuses
     * @param array<string, list<string>> $transitions
     */
    private function __construct(
        public readonly array $types,
        public readonly array $statuses,
        public readonly string $initialStatus,
        public readonly array $transitions,
        public readonly int $deadlineMonths,
        public readonly int $closedRetentionYears,
        public readonly int $searchPageSize,
        public readonly int $historyPageSize,
        public readonly int $maxBookingReferences,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        return self::fromDocument($artifacts->load('booking-domain.json'));
    }

    /** @param array<mixed> $document The decoded `booking-domain.json`. */
    public static function fromDocument(array $document): self
    {
        $policy = self::block($document, 'privacyRequests');
        $statuses = self::block($policy, 'statuses');
        $deadline = self::block($policy, 'deadline');
        $scope = self::block($policy, 'scope');
        $history = self::block($policy, 'history');
        $retention = self::block($policy, 'retention');

        $values = self::stringList($statuses, 'values');
        $initial = self::string($statuses, 'initial');
        if (!\in_array($initial, $values, true)) {
            throw new ContractArtifactException(
                'booking-domain.json privacyRequests.statuses.initial is not a status.',
            );
        }

        $transitions = [];
        $declared = self::block($statuses, 'transitions');
        foreach ($values as $status) {
            $targets = self::stringList($declared, $status);
            foreach ($targets as $target) {
                if (!\in_array($target, $values, true)) {
                    throw new ContractArtifactException(
                        "booking-domain.json privacyRequests transition {$status} → {$target} names no status.",
                    );
                }
            }
            $transitions[$status] = $targets;
        }

        return new self(
            self::stringList($policy, 'types'),
            $values,
            $initial,
            $transitions,
            self::positiveInt($deadline, 'months'),
            self::positiveInt($retention, 'closedRetentionYears'),
            self::positiveInt($scope, 'searchPageSize'),
            self::positiveInt($history, 'pageSize'),
            self::positiveInt($scope, 'maxBookingReferences'),
        );
    }

    public function acceptsType(string $type): bool
    {
        return \in_array($type, $this->types, true);
    }

    public function acceptsStatus(string $status): bool
    {
        return \in_array($status, $this->statuses, true);
    }

    /** @return list<string> */
    public function nextStatuses(string $status): array
    {
        return $this->transitions[$status] ?? [];
    }

    /**
     * @param array<mixed> $source
     * @return array<mixed>
     */
    private static function block(array $source, string $key): array
    {
        $value = $source[$key] ?? null;
        if (!\is_array($value)) {
            throw new ContractArtifactException("booking-domain.json privacyRequests has no `{$key}` block.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function string(array $source, string $key): string
    {
        $value = $source[$key] ?? null;
        if (!\is_string($value) || $value === '') {
            throw new ContractArtifactException("booking-domain.json privacyRequests has no non-empty `{$key}`.");
        }

        return $value;
    }

    /**
     * @param array<mixed> $source
     * @return list<string>
     */
    private static function stringList(array $source, string $key): array
    {
        $value = $source[$key] ?? null;
        if (!\is_array($value) || !array_is_list($value)) {
            throw new ContractArtifactException("booking-domain.json privacyRequests `{$key}` is not a list.");
        }
        $strings = [];
        foreach ($value as $item) {
            if (!\is_string($item) || $item === '') {
                throw new ContractArtifactException("booking-domain.json privacyRequests `{$key}` holds a non-string.");
            }
            $strings[] = $item;
        }

        return $strings;
    }

    /** @param array<mixed> $source */
    private static function positiveInt(array $source, string $key): int
    {
        $value = $source[$key] ?? null;
        if (!\is_int($value) || $value <= 0) {
            throw new ContractArtifactException("booking-domain.json privacyRequests has no positive `{$key}`.");
        }

        return $value;
    }
}
