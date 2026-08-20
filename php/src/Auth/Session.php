<?php

declare(strict_types=1);

namespace Eszter\Auth;

/**
 * One row of `admin_sessions`, in memory (ESZ-025).
 *
 * A session holds exactly two things: which account it belongs to, and the CSRF
 * token bound to it. Everything else on it is a deadline. There is deliberately
 * no general-purpose bag of session data — a bag is where things that should have
 * been re-derived from the database end up going stale.
 */
final class Session implements \JsonSerializable
{
    /** 256 bits, hex-encoded. */
    public const ID_BYTES = 32;
    public const ID_PATTERN = '/^[0-9a-f]{64}$/';

    public function __construct(
        public readonly string $id,
        public readonly ?int $accountId,
        public readonly string $csrfToken,
        public readonly string $createdAt,
        public readonly string $lastSeenAt,
        public readonly string $expiresAt,
        public readonly string $absoluteExpiresAt,
    ) {
    }

    public function isAuthenticated(): bool
    {
        return $this->accountId !== null;
    }

    public function withAccount(?int $accountId): self
    {
        return new self(
            $this->id,
            $accountId,
            $this->csrfToken,
            $this->createdAt,
            $this->lastSeenAt,
            $this->expiresAt,
            $this->absoluteExpiresAt,
        );
    }

    public function withDeadlines(string $lastSeenAt, string $expiresAt): self
    {
        return new self(
            $this->id,
            $this->accountId,
            $this->csrfToken,
            $this->createdAt,
            $lastSeenAt,
            $expiresAt,
            $this->absoluteExpiresAt,
        );
    }

    /**
     * A new, cryptographically random session id.
     *
     * `random_bytes()` throws rather than degrading if no CSPRNG is available,
     * which is the behaviour that matters here: a session id from a predictable
     * source is worse than no session at all, so failing the request is correct.
     */
    public static function newId(): string
    {
        return bin2hex(random_bytes(self::ID_BYTES));
    }

    /** A new CSRF token. Same size and same source as an id, for the same reason. */
    public static function newCsrfToken(): string
    {
        return bin2hex(random_bytes(self::ID_BYTES));
    }

    public static function isWellFormedId(string $value): bool
    {
        return preg_match(self::ID_PATTERN, $value) === 1;
    }

    /**
     * @param array<string, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        $strings = [];
        $columns = ['id', 'csrf_token', 'created_at', 'last_seen_at', 'expires_at', 'absolute_expires_at'];

        foreach ($columns as $column) {
            /** @var mixed $value */
            $value = $row[$column] ?? null;

            if (!\is_string($value)) {
                throw new \RuntimeException('admin_sessions row is malformed.');
            }

            $strings[$column] = $value;
        }

        /** @var mixed $accountId */
        $accountId = $row['account_id'] ?? null;

        if ($accountId !== null && !\is_int($accountId) && !\is_string($accountId)) {
            throw new \RuntimeException('admin_sessions row is malformed.');
        }

        return new self(
            $strings['id'],
            $accountId === null ? null : (int) $accountId,
            $strings['csrf_token'],
            $strings['created_at'],
            $strings['last_seen_at'],
            $strings['expires_at'],
            $strings['absolute_expires_at'],
        );
    }

    /**
     * Neither the id nor the token may be serialised by accident.
     *
     * The id is a bearer credential and the token is the other half of one, so
     * this object must not be loggable or JSON-encodable as itself. The only
     * places either value is allowed to appear are the `Set-Cookie` header and the
     * `csrfToken` field of the auth-session response, both of which read the
     * properties explicitly.
     *
     * @return array<string, scalar|null>
     */
    public function jsonSerialize(): array
    {
        return $this->__debugInfo();
    }

    /** @return array<string, scalar|null> */
    public function __debugInfo(): array
    {
        return [
            'id' => '[redacted]',
            'csrfToken' => '[redacted]',
            'accountId' => $this->accountId,
            'expiresAt' => $this->expiresAt,
        ];
    }
}
