<?php

declare(strict_types=1);

namespace Eszter\Config;

/**
 * Connection settings for the operational database (ESZ-023 / ESZ-027).
 *
 * ## Why this is a type and not three array keys
 *
 * A password that travels as a bare string ends up in a stack trace, a
 * `var_dump`, a `json_encode` of some enclosing structure, or a log context, and
 * every one of those is a place it can be read by someone who should not read it.
 * This object exists so that every one of those paths is closed at once:
 * {@see __debugInfo()} and {@see jsonSerialize()} both redact, and
 * {@see describe()} is the only thing meant for a log line.
 *
 * The DSN is redacted too, because a DSN may legally carry credentials
 * (`mysql:...;password=...` is not valid PDO syntax, but `sqlite:` and other
 * drivers embed paths and hosts that are still not log material). Only the
 * driver name and the database name survive redaction.
 */
final class DatabaseSettings implements \JsonSerializable
{
    /**
     * Placeholders shipped in `config/config.example.php`. A deployment that
     * copied the example and forgot to edit it must fail loudly, not connect to
     * nothing or — worse — to something guessable.
     *
     * @var list<string>
     */
    public const PLACEHOLDERS = ['CHANGE_ME', 'changeme', 'password', 'secret'];

    public function __construct(
        public readonly string $dsn,
        public readonly string $username,
        public readonly string $password,
        /** Seconds PDO waits for a connection before failing the request. */
        public readonly int $connectTimeoutSeconds = 5,
    ) {
    }

    /** The driver half of the DSN (`mysql`, `sqlite`, …). */
    public function driver(): string
    {
        $colon = strpos($this->dsn, ':');

        return $colon === false ? '' : strtolower(substr($this->dsn, 0, $colon));
    }

    /** The `dbname=` parameter, when the DSN carries one. */
    public function databaseName(): ?string
    {
        return preg_match('/(?:^|;)dbname=([^;]+)/i', $this->dsn, $match) === 1
            ? $match[1]
            : null;
    }

    /**
     * A form safe to put in a log line: driver and database name, nothing else.
     * No host, no port, no user, and above all no password.
     */
    public function describe(): string
    {
        return \sprintf('%s:%s', $this->driver() ?: 'unknown', $this->databaseName() ?? 'unnamed');
    }

    /** @return array<string, string> */
    public function __debugInfo(): array
    {
        return ['database' => $this->describe(), 'username' => '[redacted]', 'password' => '[redacted]'];
    }

    /** @return array<string, string> */
    public function jsonSerialize(): array
    {
        return $this->__debugInfo();
    }
}
