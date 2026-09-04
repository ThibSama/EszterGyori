<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Notification\NotificationJob;
use Eszter\Notification\NotificationTransport;

/**
 * Always throws the failure it was built with, and counts the attempts.
 */
final class FailingTransport implements NotificationTransport
{
    public int $attempted = 0;

    /**
     * Runs before the failure is thrown. Used to move the clock and hand the
     * job to a second owner mid-delivery, which is how the ESZ-111 lease-loss
     * proofs arrange "ownership lost before the guarded outcome write" without
     * making the suite wait for a real lease.
     *
     * @var (\Closure(): void)|null
     */
    public ?\Closure $before = null;

    public function __construct(
        private readonly string $channel,
        private readonly \Throwable $failure,
    ) {
    }

    public function channel(): string
    {
        return $this->channel;
    }

    public function deliver(NotificationJob $job): void
    {
        unset($job);

        if ($this->before !== null) {
            ($this->before)();
        }

        ++$this->attempted;

        throw $this->failure;
    }
}
