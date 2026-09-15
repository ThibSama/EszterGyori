<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * The effective policy for one canonical membership of services (domain
 * version 15), whether or not `booking_service_combinations` holds a row for
 * it.
 *
 * ESZ-150 shipped combinations as an allowlist: two services were bookable
 * only once the administrator had stored a validated duration for exactly
 * that membership. That requirement is corrected here. Every set of two to
 * the configured maximum of *active* services is bookable by default, for the
 * plain sum of its component durations; a stored row is an **override**:
 *
 *   - no row                            bookable, summed duration
 *   - active row, no custom duration    bookable, summed duration (identical
 *                                       to no row; the row exists only
 *                                       because it was disabled once)
 *   - active row, custom duration       bookable, that authoritative duration
 *   - disabled row                      not bookable, whatever its duration
 *
 * {@see ServiceCombinationPolicy} is the only place these four lines are
 * evaluated, and every caller — public discovery, availability, creation, the
 * repository's defence-in-depth re-check and the back-office read model —
 * reads its answer rather than restating the rule.
 */
final class EffectiveCombination
{
    /**
     * @param list<string> $serviceKeys canonical order
     * @param int $durationMinutes the duration a reservation of this
     *     membership would actually use: the custom one when there is one,
     *     the sum of the current component durations otherwise
     * @param int $proposedDurationMinutes the automatic sum, always
     * @param ?int $customDurationMinutes the stored override, or null
     * @param ?string $updatedAt the row's concurrency token, null with no row
     */
    public function __construct(
        public readonly string $key,
        public readonly array $serviceKeys,
        public readonly bool $bookable,
        public readonly int $durationMinutes,
        public readonly int $proposedDurationMinutes,
        public readonly ?int $customDurationMinutes,
        public readonly int $bufferBeforeMinutes,
        public readonly int $bufferAfterMinutes,
        public readonly bool $isExplicitlyDisabled,
        public readonly bool $hasStoredRow,
        public readonly ?string $updatedAt,
    ) {
    }

    /** Whether this membership follows the default policy rather than an override. */
    public function isImplicit(): bool
    {
        return !$this->isExplicitlyDisabled && $this->customDurationMinutes === null;
    }

    /**
     * `default` while the default-allow policy governs the membership (with
     * or without a row), `validated` while a custom duration does, `disabled`
     * for an explicit disabling override.
     */
    public function status(): string
    {
        if ($this->isExplicitlyDisabled) {
            return 'disabled';
        }

        return $this->customDurationMinutes === null ? 'default' : 'validated';
    }

    /**
     * What public discovery lists — and it lists this only for an
     * *exception*, never for a membership that follows the default policy.
     *
     * @return array<string, mixed>
     */
    public function toPublicPayload(): array
    {
        return [
            'key' => $this->key,
            'serviceKeys' => $this->serviceKeys,
            'durationMinutes' => $this->customDurationMinutes,
            'bookable' => $this->bookable,
        ];
    }

    /** @return array<string, mixed> */
    public function toAdminPayload(): array
    {
        return [
            'key' => $this->key,
            'serviceKeys' => $this->serviceKeys,
            'proposedDurationMinutes' => $this->proposedDurationMinutes,
            'durationMinutes' => $this->customDurationMinutes,
            'effectiveDurationMinutes' => $this->durationMinutes,
            'status' => $this->status(),
            'bookable' => $this->bookable,
            'updatedAt' => $this->updatedAt,
        ];
    }
}
