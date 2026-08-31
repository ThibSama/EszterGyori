<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Notification\NotificationJob;
use Eszter\Notification\NotificationTransport;

/** Counts deliveries and opens no socket. */
final class RecordingTransport implements NotificationTransport
{
    public int $delivered = 0;

    /** @var list<int> */
    public array $jobIds = [];

    /**
     * Runs before each delivery. Used to move the clock mid-batch, which is the
     * only way to reproduce "the grace window closed while the batch was queued"
     * without making the suite wait an hour.
     *
     * @var (\Closure(): void)|null
     */
    public ?\Closure $before = null;

    public function __construct(private readonly string $channel)
    {
    }

    public function channel(): string
    {
        return $this->channel;
    }

    public function deliver(NotificationJob $job): void
    {
        if ($this->before !== null) {
            ($this->before)();
        }

        ++$this->delivered;
        $this->jobIds[] = $job->id;
    }
}
