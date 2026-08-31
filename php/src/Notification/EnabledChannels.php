<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * "Is this channel switched on?", separated from where the answer is stored.
 *
 * The scheduler and the runner need the answer, not the row. Naming the question
 * as its own interface keeps `system_settings` out of the catch-up rules —
 * which are pure policy and worth asserting without a database — and leaves one
 * obvious seam for the day the answer comes from somewhere else.
 */
interface EnabledChannels
{
    /**
     * The channels currently enabled, in the contract's frozen order.
     *
     * @return list<string>
     */
    public function enabledChannels(): array;

    public function isEnabled(string $channel): bool;
}
