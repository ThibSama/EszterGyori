<?php

declare(strict_types=1);

namespace Eszter\Privacy;

use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * The register's three-year purge (ESZ-163), run by the existing daily
 * retention sweep beside the booking erasure.
 *
 * A closed record is deleted once its closure instant is at least
 * `closedRetentionYears` years in the past. Open records — received or in
 * progress — are never candidates whatever their age: an open request is
 * evidence of an obligation still owed. Counts only: the sweep never logs or
 * returns a record id or a booking reference.
 */
final class PrivacyRequestRetention
{
    public const DEFAULT_BATCH_SIZE = 500;

    public function __construct(
        private readonly PrivacyRequestRepository $requests,
        private readonly Clock $clock,
        private readonly PrivacyRequestPolicy $policy,
    ) {
    }

    /** @return array{purged: int, cutoffUtc: string} */
    public function purgeExpired(int $limit = self::DEFAULT_BATCH_SIZE, ?\DateTimeImmutable $now = null): array
    {
        $instant = ($now ?? $this->clock->now())->setTimezone(new \DateTimeZone('UTC'));
        $cutoff = $instant->modify('-' . $this->policy->closedRetentionYears . ' years');

        return [
            'purged' => $this->requests->purgeClosedBefore($cutoff, $limit),
            'cutoffUtc' => IsoTimestamp::format($cutoff),
        ];
    }
}
