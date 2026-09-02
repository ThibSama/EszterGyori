<?php

declare(strict_types=1);

namespace Eszter\Tests\Auth;

use Eszter\Admin\AccountDirectory;
use Eszter\Admin\AdminAccount;
use Eszter\Admin\AdminAccountRepository;

/**
 * The `auth.account` fixture the HTTP contract cases ask for.
 *
 * `http-contract.json` says a login case runs against an account that is
 * `enabled`, `disabled` or `missing`. Reproducing those through MySQL would make
 * `php:http-contract` depend on a database server, and the gate's whole value is
 * that it replays the frozen surface anywhere. The SQL implementation of the same
 * interface is proved separately against a real server by `sql:integration`, so
 * neither half rests on the other.
 *
 * The hash is a real `password_hash()` output rather than a stub: the timing
 * property in `auth.failureModesAreIndistinguishable` is only meaningful if the
 * work actually happens.
 */
final class InMemoryAccountDirectory implements AccountDirectory
{
    public const EMAIL = 'editor@example.test';
    public const PASSWORD = 'correct-horse-battery';

    /** @var array<int, AdminAccount> */
    private array $accounts = [];

    /** @var list<array{id: int, at: string}> */
    public array $recordedLogins = [];

    /**
     * When true, recordLogin() throws before recording anything, standing in
     * for a post-rotation persistence failure in the SQL implementation.
     */
    public bool $throwOnRecordLogin = false;

    public static function withAccount(bool $enabled): self
    {
        $directory = new self();
        $directory->add(self::EMAIL, self::PASSWORD, $enabled);

        return $directory;
    }

    public static function empty(): self
    {
        return new self();
    }

    public function add(string $email, string $password, bool $enabled): AdminAccount
    {
        $id = \count($this->accounts) + 1;

        $account = new AdminAccount(
            $id,
            $email,
            AdminAccountRepository::hash($password),
            $enabled,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            null,
        );

        $this->accounts[$id] = $account;

        return $account;
    }

    /** Flips an account's enabled flag, to exercise mid-session revocation. */
    public function setEnabled(int $id, bool $enabled): void
    {
        $account = $this->accounts[$id];

        $this->accounts[$id] = new AdminAccount(
            $account->id,
            $account->email,
            $account->passwordHash,
            $enabled,
            $account->createdAt,
            $account->updatedAt,
            $account->lastLoginAt,
        );
    }

    public function remove(int $id): void
    {
        unset($this->accounts[$id]);
    }

    public function findByEmail(string $normalizedEmail): ?AdminAccount
    {
        foreach ($this->accounts as $account) {
            if ($account->email === $normalizedEmail) {
                return $account;
            }
        }

        return null;
    }

    public function findById(int $id): ?AdminAccount
    {
        return $this->accounts[$id] ?? null;
    }

    public function recordLogin(int $id, string $at): void
    {
        if ($this->throwOnRecordLogin) {
            throw new \RuntimeException('Forced recordLogin failure after rotation.');
        }

        $this->recordedLogins[] = ['id' => $id, 'at' => $at];

        $account = $this->accounts[$id] ?? null;

        if ($account === null) {
            return;
        }

        $this->accounts[$id] = new AdminAccount(
            $account->id,
            $account->email,
            $account->passwordHash,
            $account->isEnabled,
            $account->createdAt,
            $account->updatedAt,
            $at,
        );
    }
}
