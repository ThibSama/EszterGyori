<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * One validated combination of services (ESZ-150): a row of
 * `booking_service_combinations`.
 *
 * The key *is* the membership — the member service keys sorted bytewise and
 * joined with `+` — so `serviceKeys` is derived from it and can never
 * disagree with it. `durationMinutes` is the duration the administrator
 * persisted and the only one a slot computation reads;
 * `proposedDurationMinutes` is the advisory sum recorded at validation time.
 * `updatedAt` doubles as the row's optimistic-concurrency token, as a
 * service's and a booking's do.
 */
final class ServiceCombination
{
    /** @param list<string> $serviceKeys */
    public function __construct(
        public readonly string $key,
        public readonly array $serviceKeys,
        public readonly int $proposedDurationMinutes,
        public readonly int $durationMinutes,
        public readonly int $bufferBeforeMinutes,
        public readonly int $bufferAfterMinutes,
        public readonly bool $isActive,
        public readonly string $createdAt,
        public readonly string $updatedAt,
    ) {
    }

    /**
     * The canonical key of a membership: unique keys, sorted bytewise,
     * joined with `+`. The caller has already checked each key's shape.
     *
     * @param list<string> $serviceKeys
     */
    public static function canonicalKey(array $serviceKeys): string
    {
        return implode('+', self::canonicalMembers($serviceKeys));
    }

    /**
     * @param list<string> $serviceKeys
     * @return list<string>
     */
    public static function canonicalMembers(array $serviceKeys): array
    {
        $members = array_values(array_unique($serviceKeys));
        sort($members, SORT_STRING);

        return $members;
    }

    /** @return list<string> */
    public static function membersOf(string $key): array
    {
        return explode('+', $key);
    }

    /** @param array<string, mixed> $row */
    public static function fromRow(array $row): self
    {
        $key = $row['combination_key'] ?? null;
        $proposed = $row['proposed_duration_minutes'] ?? null;
        $duration = $row['duration_minutes'] ?? null;
        $before = $row['buffer_before_minutes'] ?? null;
        $after = $row['buffer_after_minutes'] ?? null;
        $active = $row['is_active'] ?? null;
        $created = $row['created_at'] ?? null;
        $updated = $row['updated_at'] ?? null;

        if (
            !\is_string($key) || !\is_int($proposed) || !\is_int($duration)
            || !\is_int($before) || !\is_int($after)
            || !\is_string($created) || !\is_string($updated)
        ) {
            throw new \RuntimeException('booking_service_combinations row is malformed.');
        }

        return new self(
            $key,
            self::membersOf($key),
            $proposed,
            $duration,
            $before,
            $after,
            $active === 1 || $active === '1' || $active === true,
            $created,
            $updated,
        );
    }

    /**
     * The public discovery view: what the reservation page needs to offer
     * the combination — identity, members and the validated duration.
     *
     * @return array<string, mixed>
     */
    public function toPublicPayload(): array
    {
        return [
            'key' => $this->key,
            'serviceKeys' => $this->serviceKeys,
            'durationMinutes' => $this->durationMinutes,
        ];
    }

    /**
     * The back-office view (`adminServiceCombination`). The proposal shown is
     * the *current* sum of the component durations, computed by the caller
     * from the catalog, so a moved component duration is visible beside the
     * unchanged validated value.
     *
     * @return array<string, mixed>
     */
    public function toAdminPayload(int $currentProposedDurationMinutes, bool $bookable): array
    {
        return [
            'key' => $this->key,
            'serviceKeys' => $this->serviceKeys,
            'proposedDurationMinutes' => $currentProposedDurationMinutes,
            'durationMinutes' => $this->durationMinutes,
            'status' => $this->isActive ? 'validated' : 'disabled',
            'bookable' => $bookable,
            'updatedAt' => $this->updatedAt,
        ];
    }
}
