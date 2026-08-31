<?php

declare(strict_types=1);

namespace Eszter\Tests\Notification;

use Eszter\Notification\EnabledChannels;

/** A channel switch a test can flip without a database behind it. */
final class FixedEnabledChannels implements EnabledChannels
{
    /** @param list<string> $enabled */
    public function __construct(private array $enabled = ['email'])
    {
    }

    /** @param list<string> $enabled */
    public function set(array $enabled): void
    {
        $this->enabled = $enabled;
    }

    /** @return list<string> */
    public function enabledChannels(): array
    {
        return $this->enabled;
    }

    public function isEnabled(string $channel): bool
    {
        return \in_array($channel, $this->enabled, true);
    }
}
