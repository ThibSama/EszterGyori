<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * Channel → transport, resolved once before a run starts.
 *
 * The resolution happens up front, not at delivery time, because of what the
 * alternative does: a runner that discovers a missing transport while holding a
 * claimed job has to decide between failing that job — burning an attempt, and
 * eventually a notification, over a configuration mistake — and releasing it,
 * which loops. Refusing to start is neither.
 */
final class NotificationTransportRegistry
{
    /** @var array<string, NotificationTransport> */
    private array $transports = [];

    /** @param list<NotificationTransport> $transports */
    public function __construct(private readonly NotificationPolicy $policy, array $transports = [])
    {
        foreach ($transports as $transport) {
            $this->register($transport);
        }
    }

    public function register(NotificationTransport $transport): void
    {
        $channel = $transport->channel();

        if (!$this->policy->acceptsChannel($channel)) {
            throw NotificationException::invalid('channel', "`{$channel}` is not a frozen channel.");
        }

        $this->transports[$channel] = $transport;
    }

    public function has(string $channel): bool
    {
        return isset($this->transports[$channel]);
    }

    public function get(string $channel): NotificationTransport
    {
        return $this->transports[$channel]
            ?? throw NotificationException::invalid('channel', "no transport is registered for `{$channel}`.");
    }

    /**
     * The channels this registry cannot serve, out of the ones asked for.
     *
     * @param list<string> $channels
     * @return list<string>
     */
    public function missing(array $channels): array
    {
        $missing = [];
        foreach ($channels as $channel) {
            if (!$this->has($channel)) {
                $missing[] = $channel;
            }
        }

        return $missing;
    }
}
