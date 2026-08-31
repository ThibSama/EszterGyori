<?php

declare(strict_types=1);

namespace Eszter\Config;

/**
 * Session and cookie policy (ESZ-025 / ESZ-027).
 *
 * ## What is *not* here, on purpose
 *
 * The cookie name, its `HttpOnly`/`SameSite`/`Path` attributes and the CSRF
 * header are not configuration. They are frozen in `http-contract.json` under
 * `auth`, and {@see \Eszter\Auth\SessionCookie} reads them from there. A host
 * that could rename the cookie or relax `SameSite` from a config file would be a
 * host where a misconfiguration silently weakens the contract, and the contract
 * is the thing that is supposed to be un-weakenable.
 *
 * What *is* here is the part that legitimately differs per deployment: how long a
 * session may idle, how long it may live at all, and whether `Secure` may be
 * dropped — which only a non-production environment may do.
 */
final class SessionSettings
{
    public const DEFAULT_IDLE_TIMEOUT_MINUTES = 60;
    public const DEFAULT_ABSOLUTE_LIFETIME_MINUTES = 12 * 60;

    public function __construct(
        /**
         * Inactivity after which a session stops being accepted. Enforced
         * server-side against the stored record, never by the cookie's own
         * `Max-Age`, which the client controls.
         */
        public readonly int $idleTimeoutMinutes = self::DEFAULT_IDLE_TIMEOUT_MINUTES,
        /**
         * Ceiling on a session's total life regardless of activity, so a
         * continuously-used stolen session still expires.
         */
        public readonly int $absoluteLifetimeMinutes = self::DEFAULT_ABSOLUTE_LIFETIME_MINUTES,
        /**
         * `Secure` on the session cookie. True everywhere except a developer's
         * plain-HTTP localhost; {@see Configuration} refuses to boot a production
         * environment with this false.
         */
        public readonly bool $cookieSecure = true,
    ) {
    }

    public function idleTimeoutSeconds(): int
    {
        return $this->idleTimeoutMinutes * 60;
    }

    public function absoluteLifetimeSeconds(): int
    {
        return $this->absoluteLifetimeMinutes * 60;
    }
}
