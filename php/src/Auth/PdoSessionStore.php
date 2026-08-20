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

    public function collectGarbage(): int
    {
        $now = $this->clock->nowIso();

        return $this->database->run(
            'DELETE FROM admin_sessions'
            . ' WHERE expires_at <= :idle_now OR absolute_expires_at <= :absolute_now',
            ['idle_now' => $now, 'absolute_now' => $now],
        )->rowCount();
    }
}
