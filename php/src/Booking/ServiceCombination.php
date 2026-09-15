<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * One *override* of the default combination policy (ESZ-150, corrected in
 * domain version 15): a row of `booking_service_combinations`.
 *
 * The key *is* the membership — the member service keys sorted bytewise and
 * joined with `+` — so `serviceKeys` is derived from it and can never
 * disagree with it. A row exists only because the administrator overrode the
 * default: `isActive === false` disables exactly that membership, and a
 * non-null `durationMinutes` is the custom duration that replaces the
 * automatic sum for it. `durationMinutes === null` says "no custom
 * duration" — the membership follows the default policy, exactly as it would
 * with no row at all. `proposedDurationMinutes` is the sum recorded when the
 * row was last written, advisory and never read for a slot. `updatedAt`
 * doubles as the row's optimistic-concurrency token, as a service's and a
 * booking's do.
 *
 * Bookability and the effective duration are never decided here: they are
 * {@see ServiceCombinationPolicy::effectiveCombination()}'s answer.
 */
final class ServiceCombination
{
    /** @param list<string> $serviceKeys */
    public function __construct(
        public readonly string $key,
        public readonly array $serviceKeys,
        public readonly int $proposedDurationMinutes,
        public readonly ?int $durationMinutes,
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
            !\is_string($key) || !\is_int($proposed) || !($duration === null || \is_int($duration))
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
     * The custom duration this row overrides the automatic sum with, or null
     * when it holds none — a row that only disables the membership, or one
     * that was disabled and re-enabled back to the default policy.
     */
    public function customDurationMinutes(): ?int
    {
        return $this->durationMinutes;
    }
}
