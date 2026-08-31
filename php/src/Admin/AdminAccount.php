<?php

declare(strict_types=1);

namespace Eszter\Admin;

/**
 * One row of `admin_accounts`, in memory (ESZ-024).
 *
 * The password hash is on this object because the authenticator needs it and
 * fetching it separately would mean a second query on the hot path. That makes
 * every accidental serialisation of an account a hash disclosure, so both of the
 * ways PHP serialises an object by default are overridden below to redact it, and
 * {@see publicView()} is the only shape that is ever allowed onto the wire.
 */
final class AdminAccount implements \JsonSerializable
{
    public function __construct(
        public readonly int $id,
        public readonly string $email,
        public readonly string $passwordHash,
        public readonly bool $isEnabled,
        public readonly string $createdAt,
        public readonly string $updatedAt,
        public readonly ?string $lastLoginAt,
    ) {
    }

    /**
     * @param array<string, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        /** @var mixed $id */
        $id = $row['id'] ?? null;
        /** @var mixed $email */
        $email = $row['email'] ?? null;
        /** @var mixed $hash */
        $hash = $row['password_hash'] ?? null;
        /** @var mixed $enabled */
        $enabled = $row['is_enabled'] ?? null;
        /** @var mixed $createdAt */
        $createdAt = $row['created_at'] ?? null;
        /** @var mixed $updatedAt */
        $updatedAt = $row['updated_at'] ?? null;
        /** @var mixed $lastLoginAt */
        $lastLoginAt = $row['last_login_at'] ?? null;

        if (
            !\is_int($id)
            || !\is_string($email)
            || !\is_string($hash)
            || !\is_string($createdAt)
            || !\is_string($updatedAt)
            || ($lastLoginAt !== null && !\is_string($lastLoginAt))
        ) {
            throw new \RuntimeException('admin_accounts row is malformed.');
        }

        return new self(
            $id,
            $email,
            $hash,
            // MySQL hands back TINYINT(1) as an int under STRINGIFY_FETCHES=false,
            // but a driver that stringifies it would make `=== 1` silently false
            // and every account permanently disabled. Comparing loosely against
            // both forms is the honest way to be independent of that attribute.
            $enabled === 1 || $enabled === '1' || $enabled === true,
            $createdAt,
            $updatedAt,
            $lastLoginAt,
        );
    }

    /**
     * The only shape of an account that may leave the process.
     *
     * Matches `auth-session-response.schema.json` → `account`. The internal id is
     * excluded along with the hash: it is a sequential integer, so publishing it
     * would disclose how many accounts exist.
     *
     * @return array{email: string, lastLoginAt: string|null}
     */
    public function publicView(): array
    {
        return ['email' => $this->email, 'lastLoginAt' => $this->lastLoginAt];
    }

    /** @return array{email: string, lastLoginAt: string|null} */
    public function jsonSerialize(): array
    {
        return $this->publicView();
    }

    /** @return array<string, scalar|null> */
    public function __debugInfo(): array
    {
        return [
            'id' => $this->id,
            'email' => $this->email,
            'passwordHash' => '[redacted]',
            'isEnabled' => $this->isEnabled,
        ];
    }
}
