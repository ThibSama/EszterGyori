<?php

declare(strict_types=1);

namespace Eszter\Auth;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/**
 * `admin_sessions`, over PDO (ESZ-025).
 *
 * ## Two deadlines, both enforced in the query
 *
 * `expires_at` slides forward on every request (idle timeout). `absolute_expires_at`
 * is fixed when the row is created and is never extended, so a session that is
 * used continuously — which is exactly what a stolen one looks like — still dies
 * on schedule.
 *
 * Both are compared inside {@see find()}'s `WHERE`, not by a caller afterwards.
 * That is deliberate: an expiry check a caller can forget is an expiry check that
 * will eventually be forgotten, and the forgetting is silent.
 *
 * Neither deadline is ever read from the cookie. The cookie carries no `Max-Age`
 * at all and the client could lie about it if it did.
 */
final class PdoSessionStore implements SessionStore
{
    private const COLUMNS =
        'id, account_id, csrf_token, created_at, last_seen_at, expires_at, absolute_expires_at';

    /**
     * The most rows one pass removes per deadline.
     *
     * The sweep is called once per admitted anonymous-session read (ESZ-130),
     * on the request's own path, so a pass must be cheap: each of the two
     * bounded DELETEs below is an index-range delete of at most this many rows,
     * which keeps the housekeeping from becoming the request. A backlog larger
     * than one pass drains across successive admissions, and because each pass
     * only ever removes rows already past a deadline, repeated passes converge
     * to deleting nothing.
     */
    private const GC_BATCH = 200;

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
    ) {
    }

    public function find(string $id): ?Session
    {
        if (!Session::isWellFormedId($id)) {
            // Never reaches the database. A malformed id cannot match a row, so
            // querying for one only spends a round trip and puts attacker-chosen
            // bytes into a query log.
            return null;
        }

        $now = $this->clock->nowIso();

        $row = $this->database->fetchOne(
            'SELECT ' . self::COLUMNS . ' FROM admin_sessions'
            // `:idle_now` and `:absolute_now` carry the same value and cannot share
            // a placeholder: with ATTR_EMULATE_PREPARES off, PDO rewrites named
            // parameters to positional ones for the server, and reusing a name is
            // "Invalid parameter number". Emulation would hide this — and emulation
            // is exactly what this connection turns off, so the two names stay.
            . ' WHERE id = :id AND expires_at > :idle_now AND absolute_expires_at > :absolute_now',
            ['id' => $id, 'idle_now' => $now, 'absolute_now' => $now],
        );

        return $row === null ? null : Session::fromRow($row);
    }

    public function save(Session $session): void
    {
        $this->database->run(
            'INSERT INTO admin_sessions (' . self::COLUMNS . ')'
            . ' VALUES (:id, :account_id, :csrf_token, :created_at, :last_seen_at,'
            . ' :expires_at, :absolute_expires_at)'
            // `created_at` and `absolute_expires_at` are absent from the update
            // list on purpose: the absolute ceiling must not be extendable by
            // using the session, and an existing row's birth time is a fact.
            . ' ON DUPLICATE KEY UPDATE'
            . '  account_id = VALUES(account_id),'
            . '  csrf_token = VALUES(csrf_token),'
            . '  last_seen_at = VALUES(last_seen_at),'
            . '  expires_at = VALUES(expires_at)',
            [
                'id' => $session->id,
                'account_id' => $session->accountId,
                'csrf_token' => $session->csrfToken,
                'created_at' => $session->createdAt,
                'last_seen_at' => $session->lastSeenAt,
                'expires_at' => $session->expiresAt,
                'absolute_expires_at' => $session->absoluteExpiresAt,
            ],
        );
    }

    public function destroy(string $id): void
    {
        if (!Session::isWellFormedId($id)) {
            return;
        }

        $this->database->run('DELETE FROM admin_sessions WHERE id = :id', ['id' => $id]);
    }

    public function destroyForAccount(int $accountId): int
    {
        return $this->database->run(
            'DELETE FROM admin_sessions WHERE account_id = :account_id',
            ['account_id' => $accountId],
        )->rowCount();
    }

    /**
     * Deletes expired sessions in two bounded, index-backed passes (ESZ-130).
     *
     * One pass removes at most {@see GC_BATCH} idle-expired rows and at most
     * {@see GC_BATCH} absolute-expired rows, each DELETEd through its own
     * index (`expires_at` / `absolute_expires_at`) with `ORDER BY` on the same
     * column, so MySQL answers the delete as an index-range scan rather than a
     * table sweep. Both bounded statements together keep one call cheap enough
     * to sit on a request path; a backlog drains over successive calls and the
     * passes converge to zero changes because every removed row was already
     * past its deadline under the current clock.
     *
     * Neither pass can delete a live row: the two predicates are the same
     * deadline comparisons {@see find()} applies, so a row deleted here is
     * exactly a row no read could have found live.
     *
     * Unlike the rate-limit bucket sweep this is never probabilistic — the
     * kernel calls it deterministically on every admitted anonymous-session
     * read — and a failure here is *not* swallowed: it propagates so the
     * request fails through the kernel's opaque error path before a new
     * anonymous row can be created.
     *
     * @return int Sessions deleted by this pass.
     */
    public function collectGarbage(): int
    {
        $now = $this->clock->nowIso();

        $idleExpired = $this->database->run(
            'DELETE FROM admin_sessions WHERE expires_at <= :idle_now'
            . ' ORDER BY expires_at LIMIT ' . self::GC_BATCH,
            ['idle_now' => $now],
        )->rowCount();

        $absoluteExpired = $this->database->run(
            'DELETE FROM admin_sessions WHERE absolute_expires_at <= :absolute_now'
            . ' ORDER BY absolute_expires_at LIMIT ' . self::GC_BATCH,
            ['absolute_now' => $now],
        )->rowCount();

        return $idleExpired + $absoluteExpired;
    }
}
