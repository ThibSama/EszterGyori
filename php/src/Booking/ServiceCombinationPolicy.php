<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * The single domain resolver for combination policy (domain version 15).
 *
 * `effectiveCombination()` answers the only question the rest of the domain
 * ever asks about a multi-service selection — is it bookable, for how long,
 * and is that the default or an override — from three plain inputs: the
 * member catalog rows in canonical order, the stored override row for that
 * membership (or null), and the configured maximum. It is pure: no query, no
 * clock, no state. The repositories fetch; this decides.
 *
 * Nothing else in the codebase may restate the default-allow rule. Public
 * discovery, availability, booking creation, the booking repository's
 * defence-in-depth re-check and the back-office read model all funnel
 * through here, so the frontend can never offer a selection the backend
 * would refuse and the backend can never refuse a valid implicit one.
 */
final class ServiceCombinationPolicy
{
    /**
     * The effective policy for one canonical membership.
     *
     * @param list<BookableService> $members in canonical order, one per key
     *     of `$key`; the caller has already resolved them from the catalog
     * @param ?ServiceCombination $stored the override row, or null when the
     *     membership has none — which means "the default policy applies"
     */
    public function effectiveCombination(array $members, ?ServiceCombination $stored, int $max): EffectiveCombination
    {
        $keys = array_map(static fn (BookableService $member): string => $member->key, $members);
        $key = ServiceCombination::canonicalKey($keys);

        $proposed = 0;
        $before = 0;
        $after = 0;
        $allActive = true;
        foreach ($members as $member) {
            $proposed += $member->durationMinutes;
            $before = max($before, $member->bufferBeforeMinutes);
            $after = max($after, $member->bufferAfterMinutes);
            $allActive = $allActive && $member->isActive;
        }

        $custom = $stored?->customDurationMinutes();
        $disabled = $stored !== null && !$stored->isActive;
        // A custom duration carries the buffers snapshotted beside it; the
        // default policy reads the members' current buffers, exactly as it
        // reads their current durations.
        $bufferBefore = $custom === null ? $before : $stored->bufferBeforeMinutes;
        $bufferAfter = $custom === null ? $after : $stored->bufferAfterMinutes;

        $bookable = $allActive
            && !$disabled
            && \count($members) >= 2
            && \count($members) <= $max;

        return new EffectiveCombination(
            $key,
            $keys,
            $bookable,
            $custom ?? $proposed,
            $proposed,
            $custom,
            $bufferBefore,
            $bufferAfter,
            $disabled,
            $stored !== null,
            $stored?->updatedAt,
        );
    }
}
