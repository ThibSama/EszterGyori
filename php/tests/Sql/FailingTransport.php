<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Notification\NotificationJob;
use Eszter\Notification\NotificationTransport;

/** Always throws the failure it was built with, and counts the attempts. */
final class FailingTransport implements NotificationTransport
{
    public int $attempted = 0;

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
        ++$this->attempted;

        throw $this->failure;
    }
}
