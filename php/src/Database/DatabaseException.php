<?php

declare(strict_types=1);

namespace Eszter\Database;

/**
 * A database failure, stripped of anything that identifies the connection.
 *
 * PDO's own exception messages routinely carry the DSN, the host and the user,
 * and PDO puts the failing SQL in `getMessage()` on a prepare error. None of that
 * may reach a response body, and this project's convention (`ErrorCatalog`,
 * `StorageException`) is that the HTTP layer answers opaquely while the log gets
 * the detail. So the detail is carried in {@see logContext()}, which only the
 * logger reads, and the message itself stays generic.
 */
final class DatabaseException extends \RuntimeException
{
    /** @param array<string, scalar|null> $context */
    private function __construct(
        string $message,
        private readonly array $context = [],
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    public static function connectionFailed(string $describedTarget, \Throwable $previous): self
    {
        return new self(
            'The database connection could not be established.',
            ['database' => $describedTarget, 'driverMessage' => self::scrub($previous->getMessage())],
            $previous,
        );
    }

    public static function queryFailed(string $operation, \Throwable $previous): self
    {
        return new self(
            'A database statement failed.',
            ['operation' => $operation, 'driverMessage' => self::scrub($previous->getMessage())],
            $previous,
        );
    }

    /** @param array<string, scalar|null> $context */
    public static function invariant(string $message, array $context = []): self
    {
        return new self($message, $context);
    }

    /** @return array<string, scalar|null> */
    public function logContext(): array
    {
        return $this->context;
    }

    /**
     * Removes credential-shaped fragments from a driver message before it is
     * allowed anywhere, including the log. The log is not a public place, but a
     * password written there is a password that outlives the incident.
     */
    private static function scrub(string $message): string
    {
        return (string) preg_replace(
            [
                '/\b(password|pwd|passwd)\s*=\s*\S+/i',
                '/\bidentified\s+by\s+\S+/i',
            ],
            '$1=[redacted]',
            $message,
        );
    }
}
