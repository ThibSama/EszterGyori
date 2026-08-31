<?php

declare(strict_types=1);

namespace Eszter\Auth;

/**
 * Where sessions live.
 *
 * An interface for the same reason {@see \Eszter\Admin\AccountDirectory} is one:
 * `php:http-contract` replays the whole frozen surface against the real front
 * controller and must not need a MySQL server to do it, while `sql:integration`
 * proves the SQL implementation against a real one. Neither half is taken on
 * trust, and the seam is the same seam `PublishedContentReader` already
 * established for storage.
 *
 * Implementations must treat expiry as their own responsibility: {@see find()}
 * returns null for a session past either of its deadlines, so no caller can
 * forget to check.
 */
interface SessionStore
{
    /** The live session with this id, or null if it is unknown or expired. */
    public function find(string $id): ?Session;

    /** Inserts or updates. The absolute deadline is never extended by a write. */
    public function save(Session $session): void;

    public function destroy(string $id): void;

    /**
     * Destroys every session of one account, so that disabling an account signs
     * it out everywhere rather than only preventing the next login.
     *
     * @return int Sessions destroyed.
     */
    public function destroyForAccount(int $accountId): int;

    /**
     * Deletes sessions past either deadline.
     *
     * @return int Sessions deleted.
     */
    public function collectGarbage(): int;
}
