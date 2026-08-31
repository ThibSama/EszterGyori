<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;

/**
 * The generated Package 4.1/4.2 booking contract, consumed rather than restated.
 *
 * Service keys come directly from `SiteContent.services.items[].id`; the timezone
 * and state graph are frozen beside them. PHP therefore cannot quietly accept a
 * service or transition the language-neutral contract does not contain.
 */
final class BookingDomainContract
{
    /**
     * @param list<string> $serviceKeys
     * @param list<string> $foldOffsets
     * @param list<string> $states
     * @param array<string, list<string>> $transitions
     */
    private function __construct(
        public readonly int $version,
        public readonly string $timezone,
        public readonly array $serviceKeys,
        public readonly string $serviceKeyPattern,
        public readonly int $labelMaxLength,
        public readonly int $durationMinMinutes,
        public readonly int $durationMaxMinutes,
        public readonly int $bufferMaxMinutes,
        public readonly array $foldOffsets,
        public readonly int $slotGridMinutes,
        public readonly int $slotMaxHorizonDays,
        public readonly int $slotMaxResults,
        public readonly array $states,
        public readonly string $initialState,
        public readonly array $transitions,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        $document = $artifacts->load('booking-domain.json');
        $services = self::block($document, 'services');
        $timezone = self::block($document, 'timezone');
        $states = self::block($document, 'states');
        $availability = self::block($document, 'availability');
        $grid = self::block($availability, 'grid');
        $limits = self::block($availability, 'limits');
        $dst = self::block($timezone, 'dst');
        $duration = self::block($services, 'durationMinutes');
        $buffer = self::block($services, 'bufferMinutes');

        return new self(
            self::positiveInt($document, 'version'),
            self::string($timezone, 'iana'),
            self::stringList($services, 'keys'),
            self::string($services, 'keyPattern'),
            self::positiveInt($services, 'labelMaxLength'),
            self::positiveInt($duration, 'min'),
            self::positiveInt($duration, 'max'),
            self::nonNegativeInt($buffer, 'max'),
            self::stringList($dst, 'foldOffsets'),
            self::positiveInt($grid, 'minutes'),
            self::positiveInt($limits, 'maxHorizonDays'),
            self::positiveInt($limits, 'maxResults'),
            self::stringList($states, 'values'),
            self::string($states, 'initial'),
            self::transitionMap($states),
        );
    }

    public function acceptsServiceKey(string $key): bool
    {
        return \in_array($key, $this->serviceKeys, true)
            && preg_match('#' . $this->serviceKeyPattern . '#D', $key) === 1;
    }

    public function acceptsState(string $state): bool
    {
        return \in_array($state, $this->states, true);
    }

    /** @return list<string> */
    public function nextStates(string $state): array
    {
        return $this->transitions[$state] ?? [];
    }

    /**
     * @param array<mixed> $source
     * @return array<mixed>
     */
    private static function block(array $source, string $key): array
    {
        $value = $source[$key] ?? null;

        if (!\is_array($value)) {
            throw new ContractArtifactException("booking-domain.json has no `{$key}` block.");
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

    /** @param array<mixed> $source */
    private static function nonNegativeInt(array $source, string $key): int
    {
        $value = $source[$key] ?? null;

        if (!\is_int($value) || $value < 0) {
            throw new ContractArtifactException("booking-domain.json has no non-negative `{$key}` integer.");
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

        if (!\is_array($value) || $value === []) {
            throw new ContractArtifactException("booking-domain.json has no non-empty `{$key}` list.");
        }

        $strings = [];
        foreach ($value as $entry) {
            if (!\is_string($entry) || $entry === '') {
                throw new ContractArtifactException("booking-domain.json has a malformed `{$key}` entry.");
            }
            $strings[] = $entry;
        }

        return $strings;
    }

    /**
     * @param array<mixed> $states
     * @return array<string, list<string>>
     */
    private static function transitionMap(array $states): array
    {
        $value = $states['transitions'] ?? null;

        if (!\is_array($value)) {
            throw new ContractArtifactException('booking-domain.json has no state transition map.');
        }

        $map = [];
        foreach ($value as $from => $targets) {
            if (!\is_string($from) || !\is_array($targets)) {
                throw new ContractArtifactException('booking-domain.json has a malformed state transition.');
            }
            $map[$from] = [];
            foreach ($targets as $target) {
                if (!\is_string($target)) {
                    throw new ContractArtifactException('booking-domain.json has a non-string transition target.');
                }
                $map[$from][] = $target;
            }
        }

        return $map;
    }
}
