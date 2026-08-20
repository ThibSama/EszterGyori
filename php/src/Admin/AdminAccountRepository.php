<?php

declare(strict_types=1);

namespace Eszter\Admin;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/**
 * `admin_accounts`, over PDO (ESZ-024).
 *
 * ## Hashing
 *
 * `password_hash()` with `PASSWORD_DEFAULT`, not a pinned algorithm. The default
 * is Argon2id where the build provides it and bcrypt otherwise, which is exactly
 * the preference `docs/hetzner-target-architecture.md` §6 states, and pinning
 * would freeze this application on whatever was current the day it was written.
 * The column is sized for the growth that implies, and {@see needsRehash()} lets
 * an existing hash be upgraded on the next successful sign-in.
 *
 * ## Provisioning is repeat-safe
 *
 * {@see provision()} is an upsert on the normalised address, so running it twice
 * with the same arguments leaves one account in the same state rather than
 * failing on the unique index or creating a second row. That matters because the
 * realistic way it gets run is twice: once by the operator, once by the operator
 * who is not sure the first one worked.
 */
final class AdminAccountRepository implements AccountDirectory
{
    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
    ) {
    }

    public function findByEmail(string $normalizedEmail): ?AdminAccount
    {
        $row = $this->database->fetchOne(
            'SELECT id, email, password_hash, is_enabled, created_at, updated_at, last_login_at'
            . ' FROM admin_accounts WHERE email = :email',
            ['email' => $normalizedEmail],
        );

        return $row === null ? null : AdminAccount::fromRow($row);
    }

    public function findById(int $id): ?AdminAccount
    {
        $row = $this->database->fetchOne(
            'SELECT id, email, password_hash, is_enabled, created_at, updated_at, last_login_at'
            . ' FROM admin_accounts WHERE id = :id',
            ['id' => $id],
        );

        return $row === null ? null : AdminAccount::fromRow($row);
    }

    public function recordLogin(int $id, string $at): void
    {
        $this->database->run(
            'UPDATE admin_accounts SET last_login_at = :at WHERE id = :id',
            ['at' => $at, 'id' => $id],
        );
    }

    /** @return list<AdminAccount> */
    public function all(): array
    {
        $accounts = [];

        foreach (
            $this->database->fetchAll(
                'SELECT id, email, password_hash, is_enabled, created_at, updated_at, last_login_at'
                . ' FROM admin_accounts ORDER BY email ASC',
            ) as $row
        ) {
            $accounts[] = AdminAccount::fromRow($row);
        }

        return $accounts;
    }

    /**
     * Creates or updates one account. The only write path there is.
     *
     * @param string|null $plainPassword Null leaves an existing hash untouched;
     *        required when the account does not exist yet, because an account
     *        with no password is an account nobody can use and everybody can see.
     * @return array{account: AdminAccount, created: bool, passwordChanged: bool}
     */
    public function provision(AdminEmail $email, ?string $plainPassword, bool $enabled): array
    {
        return $this->database->transactional(
            function () use ($email, $plainPassword, $enabled): array {
                $now = $this->clock->nowIso();
                $existing = $this->findByEmail($email->value);

                if ($existing === null) {
                    if ($plainPassword === null) {
                        throw new \InvalidArgumentException(
                            'A new account needs a password; there is no such thing as an account without one.',
                        );
                    }

                    $this->database->run(
                        'INSERT INTO admin_accounts'
                        . ' (email, password_hash, is_enabled, created_at, updated_at)'
                        . ' VALUES (:email, :hash, :enabled, :created_at, :updated_at)',
                        [
                            'email' => $email->value,
                            'hash' => self::hash($plainPassword),
                            'enabled' => $enabled ? 1 : 0,
                            'created_at' => $now,
                            'updated_at' => $now,
                        ],
                    );

                    $created = $this->findByEmail($email->value);

                    if ($created === null) {
                        throw new \RuntimeException('The account disappeared immediately after insertion.');
                    }

                    return ['account' => $created, 'created' => true, 'passwordChanged' => true];
                }

                $passwordChanged = $plainPassword !== null;

                $this->database->run(
                    'UPDATE admin_accounts'
                    . ' SET password_hash = :hash, is_enabled = :enabled, updated_at = :updated_at'
                    . ' WHERE id = :id',
                    [
                        'hash' => $passwordChanged
                            ? self::hash((string) $plainPassword)
                            : $existing->passwordHash,
                        'enabled' => $enabled ? 1 : 0,
                        'updated_at' => $now,
                        'id' => $existing->id,
                    ],
                );

                $updated = $this->findById($existing->id);

                if ($updated === null) {
                    throw new \RuntimeException('The account disappeared during provisioning.');
                }

                return [
                    'account' => $updated,
                    'created' => false,
                    'passwordChanged' => $passwordChanged,
                ];
            },
        );
    }

    /** Replaces a hash that an algorithm or cost change has left behind. */
    public function upgradeHash(int $id, string $plainPassword): void
    {
        $this->database->run(
            'UPDATE admin_accounts SET password_hash = :hash, updated_at = :updated_at WHERE id = :id',
            ['hash' => self::hash($plainPassword), 'updated_at' => $this->clock->nowIso(), 'id' => $id],
        );
    }

    /**
     * `PASSWORD_DEFAULT`, never a pinned algorithm.
     *
     * Since PHP 8 this cannot fail: it throws on an unknown algorithm and returns
     * a non-empty string otherwise, so there is no false or empty result to guard
     * against. The guard that used to be here is gone rather than kept as
     * reassurance — a branch that can never be taken is a branch no test covers.
     */
    public static function hash(string $plainPassword): string
    {
        return password_hash($plainPassword, PASSWORD_DEFAULT);
    }

    public static function needsRehash(string $hash): bool
    {
        return password_needs_rehash($hash, PASSWORD_DEFAULT);
    }
}
