<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/**
 * Which channels are switched on, read from `system_settings` (ESZ-072).
 *
 * A setting rather than configuration because it is an operational decision the
 * salon makes — SMS costs money and email does not — and it has to be reversible
 * without a deploy. `system_settings` was created in ESZ-040 for exactly this and
 * has been sitting empty since; this is its first key.
 *
 * The default when the row is absent is email-only. Defaulting to "everything
 * on" would mean that a database restored without its settings starts sending
 * SMS, which is the expensive direction to be wrong in.
 */
final class NotificationChannelSettings implements EnabledChannels
{
    public const SETTING_KEY = 'notifications.channels';

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly NotificationPolicy $policy,
    ) {
    }

    /**
     * The channels currently enabled, in frozen order.
     *
     * @return list<string>
     */
    public function enabledChannels(): array
    {
        $stored = $this->stored();
        $enabled = [];

        foreach ($this->policy->channels as $channel) {
            $value = $stored[$channel] ?? ($channel === 'email');
            if ($value === true) {
                $enabled[] = $channel;
            }
        }

        return $enabled;
    }

    public function isEnabled(string $channel): bool
    {
        return \in_array($channel, $this->enabledChannels(), true);
    }

    /**
     * Switches a channel on or off.
     *
     * Note what this deliberately does *not* do: it never touches existing jobs.
     * Re-enabling SMS changes what the next enqueue produces and nothing else,
     * because the jobs that were refused while it was off were recorded as
     * terminally skipped at the time. There is therefore no backlog for a
     * re-enable to flush, and no burst to rate-limit — the burst was prevented
     * months earlier, at the moment each notification was declined.
     */
    public function setEnabled(string $channel, bool $enabled): void
    {
        if (!$this->policy->acceptsChannel($channel)) {
            throw NotificationException::invalid('channel', "`{$channel}` is not a frozen channel.");
        }

        $state = $this->stored();
        $state[$channel] = $enabled;

        foreach ($this->policy->channels as $known) {
            $state[$known] = $state[$known] ?? ($known === 'email');
        }

        $json = json_encode($state, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            throw new NotificationException('Channel settings are not JSON encodable.');
        }

        $now = $this->clock->nowIso();

        $this->database->run(
            'INSERT INTO system_settings (setting_key, value_json, created_at, updated_at)'
            . ' VALUES (:key, :value, :createdAt, :updatedAt)'
            . ' ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at)',
            ['key' => self::SETTING_KEY, 'value' => $json, 'createdAt' => $now, 'updatedAt' => $now],
        );
    }

    /** @return array<string, bool> */
    private function stored(): array
    {
        $row = $this->database->fetchOne(
            'SELECT value_json FROM system_settings WHERE setting_key = :key',
            ['key' => self::SETTING_KEY],
        );

        $json = $row['value_json'] ?? null;
        if (!\is_string($json)) {
            return [];
        }

        /** @var mixed $decoded */
        $decoded = json_decode($json, true);
        if (!\is_array($decoded)) {
            return [];
        }

        $state = [];
        foreach ($decoded as $channel => $value) {
            if (\is_string($channel) && \is_bool($value) && $this->policy->acceptsChannel($channel)) {
                $state[$channel] = $value;
            }
        }

        return $state;
    }
}
