<?php

declare(strict_types=1);

namespace Eszter\Tests\Auth;

use Eszter\Auth\Session;
use Eszter\Auth\SessionStore;
use Eszter\Support\Clock;

/**
 * `admin_sessions` in an array, for the contract runner.
 *
 * The expiry rule is reimplemented here rather than skipped, because
 * {@see SessionStore::find()} promising "live sessions only" is the reason no
 * caller checks a deadline. A double that returned expired rows would make the
 * suite green against an implementation that had stopped enforcing them.
 */
final class InMemorySessionStore implements SessionStore
{
    /** @var array<string, Session> */
    public array $sessions = [];

    /**
     * Every save, in order, so a test can name the session a rotation created
     * even after it was destroyed again.
     *
     * @var list<array{id: string, accountId: int|null}>
     */
    public array $saveHistory = [];

    /**
     * When true, the next destroy() call is allowed through and arms
     * {@see $throwOnDestroy} — so a test can make the *second* destroy of a
     * request fail (the rotation's own destroy of the anonymous row succeeds,
     * the revocation's destroy of the rotated row throws).
     */
    public bool $armThrowOnNextDestroy = false;

    /** When true, destroy() throws without removing anything. */
    public bool $throwOnDestroy = false;

    public function __construct(private readonly Clock $clock)
    {
    }

    public function find(string $id): ?Session
    {
        if (!Session::isWellFormedId($id)) {
            return null;
        }

        $session = $this->sessions[$id] ?? null;

        if ($session === null) {
            return null;
        }

        $now = $this->clock->nowIso();

        // String comparison is correct here and not a shortcut: the canonical
        // timestamp is fixed-width UTC, so lexical order is chronological order.
        if ($session->expiresAt <= $now || $session->absoluteExpiresAt <= $now) {
            return null;
        }

        return $session;
    }

    /** When true, save() throws without recording or storing anything. */
    public bool $throwOnSave = false;

    public function save(Session $session): void
    {
        if ($this->throwOnSave) {
            throw new \RuntimeException('Forced session save failure.');
        }

        $this->saveHistory[] = ['id' => $session->id, 'accountId' => $session->accountId];

        $existing = $this->sessions[$session->id] ?? null;

        // Mirrors the SQL `ON DUPLICATE KEY UPDATE` list: the absolute ceiling and
        // the birth time of an existing row are never overwritten.
        $this->sessions[$session->id] = $existing === null
            ? $session
            : new Session(
                $session->id,
                $session->accountId,
                $session->csrfToken,
                $existing->createdAt,
                $session->lastSeenAt,
                $session->expiresAt,
                $existing->absoluteExpiresAt,
            );
    }

    public function destroy(string $id): void
    {
        if ($this->throwOnDestroy) {
            throw new \RuntimeException('Forced session destroy failure.');
        }

        // Consumed after the throw check, so the destroy that arms the failure
        // is allowed through and the *next* one throws.
        if ($this->armThrowOnNextDestroy) {
            $this->armThrowOnNextDestroy = false;
            $this->throwOnDestroy = true;
        }

        unset($this->sessions[$id]);
    }

    public function destroyForAccount(int $accountId): int
    {
        $destroyed = 0;

        foreach ($this->sessions as $id => $session) {
            if ($session->accountId === $accountId) {
                unset($this->sessions[$id]);
                ++$destroyed;
            }
        }

        return $destroyed;
    }

    public function collectGarbage(): int
    {
        $now = $this->clock->nowIso();
        $deleted = 0;

        foreach ($this->sessions as $id => $session) {
            if ($session->expiresAt <= $now || $session->absoluteExpiresAt <= $now) {
                unset($this->sessions[$id]);
                ++$deleted;
            }
        }

        return $deleted;
    }

    /** Seeds a session directly, the way a previous request would have left one. */
    public function seed(?int $accountId, Clock $clock): Session
    {
        $now = $clock->now();

        $session = new Session(
            Session::newId(),
            $accountId,
            Session::newCsrfToken(),
            \Eszter\Support\IsoTimestamp::format($now),
            \Eszter\Support\IsoTimestamp::format($now),
            \Eszter\Support\IsoTimestamp::format($now->modify('+1 hour')),
            \Eszter\Support\IsoTimestamp::format($now->modify('+12 hours')),
        );

        $this->sessions[$session->id] = $session;

        return $session;
    }
}
