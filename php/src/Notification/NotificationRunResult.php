<?php

declare(strict_types=1);

namespace Eszter\Notification;

/** What one cron tick did. Counts only — never a customer fact. */
final class NotificationRunResult
{
    public function __construct(
        public readonly int $recovered,
        public readonly int $staleSkipped,
        public readonly int $claimed,
        public readonly int $sent,
        public readonly int $retried,
        public readonly int $failed,
        public readonly int $skipped,
        public readonly int $leasesLost,
        /**
         * ESZ-164 — claimed jobs released back to pending because their
         * booking was under a restriction of processing at delivery time.
         * Nothing was sent and no attempt was spent.
         */
        public readonly int $released = 0,
    ) {
    }

    public function describe(): string
    {
        return \sprintf(
            'recovered=%d stale_skipped=%d claimed=%d sent=%d retried=%d failed=%d skipped=%d leases_lost=%d'
            . ' released=%d',
            $this->recovered,
            $this->staleSkipped,
            $this->claimed,
            $this->sent,
            $this->retried,
            $this->failed,
            $this->skipped,
            $this->leasesLost,
            $this->released,
        );
    }
}
