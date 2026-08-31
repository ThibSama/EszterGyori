<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * The provider-neutral delivery seam (ESZ-071).
 *
 * This is the only way the runner reaches the outside world. Package 7.1 ships
 * no SMTP client and no SMS client, and that is a deliberate boundary rather
 * than an unfinished edge: the queue, the leases, the retries and the catch-up
 * rules are all decidable without a provider, and choosing one is a procurement
 * decision with credentials attached.
 *
 * A transport is called *outside* any database transaction. It may block, and it
 * may take as long as the lease allows; what it must not do is assume the row is
 * still its own when it returns. {@see NotificationJobRepository::markSent()}
 * re-checks the lease, so a slow transport whose lease expired cannot record a
 * delivery it no longer owns.
 */
interface NotificationTransport
{
    /** The channel this transport serves; one of the frozen channel values. */
    public function channel(): string;

    /**
     * Delivers one notification, or throws.
     *
     * Returning normally means "handed to the provider and accepted". Anything
     * else must throw {@see TransientDeliveryException} or
     * {@see PermanentDeliveryException}; the distinction is the transport's to
     * make, because only it knows whether its provider's refusal was about this
     * moment or about this recipient.
     */
    public function deliver(NotificationJob $job): void;
}
