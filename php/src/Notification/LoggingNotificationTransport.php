<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Support\Logger;

/**
 * The V1 transport: it records that a delivery was dispatched and touches no
 * network at all.
 *
 * This is not a stub standing in for a missing feature — it is what "no provider
 * is chosen yet" honestly looks like from the runner's side. It proves the seam
 * end to end (a job is claimed, dispatched, marked sent once, and never
 * delivered twice) without a credential, an outbound port, or the possibility of
 * mailing a real customer from a developer's laptop.
 *
 * It writes through {@see NotificationLogContext}, so even the transport's own
 * line is allowlisted and cannot carry an address.
 */
final class LoggingNotificationTransport implements NotificationTransport
{
    public function __construct(
        private readonly string $channel,
        private readonly Logger $logger,
        private readonly NotificationPolicy $policy,
    ) {
        if (!$policy->acceptsChannel($channel)) {
            throw NotificationException::invalid('channel', "`{$channel}` is not a frozen channel.");
        }
    }

    public function channel(): string
    {
        return $this->channel;
    }

    public function deliver(NotificationJob $job): void
    {
        $this->logger->info(
            'notification.dispatched',
            NotificationLogContext::forJob($job, $this->policy, ['status' => 'dispatched']),
        );
    }
}
