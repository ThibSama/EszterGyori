<?php

declare(strict_types=1);

namespace Eszter\Database;

use Eszter\Config\DatabaseSettings;
use Eszter\Storage\ApplicationSnapshotLock;

/**
 * The one door onto SQL (ESZ-023).
 *
 * ## Connection policy
 *
 * Lazy. The public read-only surface — `/`, `/api/health`, `/api/content` — must
 * never open a connection, because on shared hosting every request is a process
 * and a connection it does not need is latency it pays for nothing. Constructing
 * this object is therefore free; {@see pdo()} is what costs.
 *
 * ## Error policy, and why the defaults are all wrong
 *
 * Four PDO attributes are set here and each one overrides a default that fails
 * silently:
 *
 *  - `ERRMODE_EXCEPTION` — the default is `ERRMODE_SILENT`, under which a failed
 *    statement returns false and execution continues with a wrong result.
 *  - `EMULATE_PREPARES = false` — with emulation on, PDO interpolates parameters
 *    into the SQL string itself using its own quoting, so "prepared statements
 *    only" is not actually true and the placeholder types are decided by PDO
 *    rather than by the server.
 *  - `STRINGIFY_FETCHES = false` — combined with the above, an `INT` column comes
 *    back as an `int`, so `$row['is_enabled'] === 1` means what it looks like it
 *    means rather than being false against the string `"1"`.
 *  - `DEFAULT_FETCH_MODE = FETCH_ASSOC` — the default returns every column twice,
 *    once by name and once by position, which doubles the memory and makes any
 *    `foreach` over a row wrong.
 *
 * Nothing calls `PDO::query()` with an interpolated string anywhere in this
 * package; {@see run()} and {@see fetchAll()} take parameters, and the only
 * statements that carry no parameters are the DDL in `migrations/`.
 */
final class Database
{
    private ?\PDO $pdo = null;

    /** Depth of nested {@see transactional()} calls; only the outermost commits. */
    private int $transactionDepth = 0;

    private readonly ?ApplicationSnapshotLock $snapshotLock;

    /**
     * ESZ-145 test seam: an optional observer invoked once per executed
     * statement with the statement text, so a proof can count queries
     * deterministically without logging bind values.
     *
     * Production never sets it — it exists so the SQL suite can attach a
     * counting closure to the very `Database` instance a kernel or repository
     * is wired to and assert exact statement counts around one use case. The
     * statement text is deliberately the only thing the observer receives:
     * parameters (and therefore the values they carry) never leave the
     * prepared-statement path.
     *
     * @var \Closure(string): void|null
     */
    private ?\Closure $statementObserver = null;

    public function __construct(private readonly DatabaseSettings $settings, ?string $lockDirectory = null)
    {
        $this->snapshotLock = $lockDirectory === null ? null : new ApplicationSnapshotLock($lockDirectory);
    }

    /**
     * ESZ-145 — attaches or detaches the statement observer.
     *
     * @param \Closure(string): void|null $observer receives the text of every
     *     statement the database executes from this point on; null detaches.
     */
    public function observeStatements(?\Closure $observer): void
    {
        $this->statementObserver = $observer;
    }

    /** Wraps an already-open handle. Used by the integration suite. */
    public static function fromPdo(\PDO $pdo, DatabaseSettings $settings): self
    {
        $database = new self($settings);
        $database->pdo = self::applyAttributes($pdo);

        return $database;
    }

    public function settings(): DatabaseSettings
    {
        return $this->settings;
    }

    public function isConnected(): bool
    {
        return $this->pdo !== null;
    }

    public function pdo(): \PDO
    {
        if ($this->pdo !== null) {
            return $this->pdo;
        }

        try {
            $pdo = new \PDO(
                $this->settings->dsn,
                $this->settings->username,
                $this->settings->password,
                [\PDO::ATTR_TIMEOUT => $this->settings->connectTimeoutSeconds],
            );
        } catch (\PDOException $exception) {
            // `new PDO(...)` puts the DSN and the user in the exception message.
            throw DatabaseException::connectionFailed($this->settings->describe(), $exception);
        }

        return $this->pdo = self::applyAttributes($pdo);
    }

    private static function applyAttributes(\PDO $pdo): \PDO
    {
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE, \PDO::FETCH_ASSOC);
        $pdo->setAttribute(\PDO::ATTR_EMULATE_PREPARES, false);
        $pdo->setAttribute(\PDO::ATTR_STRINGIFY_FETCHES, false);

        return $pdo;
    }

    /**
     * Runs a parameterised statement and returns it, so a caller can read
     * `rowCount()`.
     *
     * @param array<string, scalar|null> $parameters
     */
    public function run(string $sql, array $parameters = []): \PDOStatement
    {
        if ($this->transactionDepth === 0 && self::mutates($sql)) {
            return $this->withMutation(fn (): \PDOStatement => $this->runUnlocked($sql, $parameters));
        }

        return $this->runUnlocked($sql, $parameters);
    }

    /** @param array<string, scalar|null> $parameters */
    private function runUnlocked(string $sql, array $parameters): \PDOStatement
    {
        $this->statementObserver?->__invoke($sql);

        try {
            $statement = $this->pdo()->prepare($sql);
            $statement->execute($parameters);

            return $statement;
        } catch (\PDOException $exception) {
            throw DatabaseException::queryFailed(self::describeStatement($sql), $exception);
        }
    }

    /**
     * @param array<string, scalar|null> $parameters
     * @return list<array<string, mixed>>
     */
    public function fetchAll(string $sql, array $parameters = []): array
    {
        /** @var list<array<string, mixed>> $rows */
        $rows = $this->run($sql, $parameters)->fetchAll();

        return $rows;
    }

    /**
     * @param array<string, scalar|null> $parameters
     * @return array<string, mixed>|null
     */
    public function fetchOne(string $sql, array $parameters = []): ?array
    {
        /** @var mixed $row */
        $row = $this->run($sql, $parameters)->fetch();

        /** @var array<string, mixed>|null */
        return \is_array($row) ? $row : null;
    }

    /**
     * Runs raw SQL with no parameters. Migrations only.
     *
     * Separate from {@see run()} and named so that a `grep` for it finds every
     * place a statement is not prepared. There is exactly one caller.
     */
    public function executeRaw(string $sql, string $operation): void
    {
        if ($this->transactionDepth === 0 && self::mutates($sql)) {
            $this->withMutation(function () use ($sql, $operation): void {
                $this->executeRawUnlocked($sql, $operation);
            });

            return;
        }

        $this->executeRawUnlocked($sql, $operation);
    }

    private function executeRawUnlocked(string $sql, string $operation): void
    {
        $this->statementObserver?->__invoke($sql);

        try {
            $this->pdo()->exec($sql);
        } catch (\PDOException $exception) {
            throw DatabaseException::queryFailed($operation, $exception);
        }
    }

    public function inTransaction(): bool
    {
        return $this->transactionDepth > 0;
    }

    /**
     * Opens a transaction the caller will end itself.
     *
     * Exists for test isolation: the `sql:integration` gate wraps each test in a
     * transaction and rolls it back, so a test leaves the database exactly as it
     * found it without `TRUNCATE` — which on MySQL commits implicitly and would
     * defeat the rollback it is supposed to help.
     *
     * It goes through the same depth counter {@see transactional()} uses, rather
     * than reaching for the PDO handle directly. A caller that bypassed the
     * counter would leave `transactional()` believing no transaction was open, and
     * its `beginTransaction()` would then fail with "There is already an active
     * transaction" — which is precisely what happened before this method existed.
     * With the counter shared, a repository's own `transactional()` call nests
     * into the caller's transaction and is undone with it.
     */
    public function beginTransaction(): void
    {
        if ($this->transactionDepth > 0) {
            ++$this->transactionDepth;

            return;
        }

        try {
            $this->pdo()->beginTransaction();
        } catch (\PDOException $exception) {
            throw DatabaseException::queryFailed('BEGIN', $exception);
        }

        $this->transactionDepth = 1;
    }

    /** Discards everything since the outermost {@see beginTransaction()}. */
    public function rollBack(): void
    {
        $this->transactionDepth = 0;

        try {
            if ($this->pdo()->inTransaction()) {
                $this->pdo()->rollBack();
            }
        } catch (\PDOException $exception) {
            throw DatabaseException::queryFailed('ROLLBACK', $exception);
        }
    }

    /**
     * Runs a closure inside a transaction, committing on return and rolling back
     * on any throwable.
     *
     * Nesting is counted rather than emulated with savepoints: every nested call
     * joins the outermost transaction, and a throw from anywhere inside rolls the
     * whole thing back. Savepoints would let an inner failure be swallowed while
     * the outer transaction still commits, which is exactly the outcome a
     * transaction is supposed to make impossible.
     *
     * @template T
     * @param \Closure(self): T $work
     * @return T
     */
    public function transactional(\Closure $work): mixed
    {
        if ($this->transactionDepth > 0) {
            ++$this->transactionDepth;

            try {
                return $work($this);
            } finally {
                --$this->transactionDepth;
            }
        }

        return $this->withMutation(fn (): mixed => $this->transactionalUnlocked($work));
    }

    /**
     * @template T
     * @param \Closure(self): T $work
     * @return T
     */
    private function transactionalUnlocked(\Closure $work): mixed
    {
        $pdo = $this->pdo();

        try {
            $pdo->beginTransaction();
        } catch (\PDOException $exception) {
            throw DatabaseException::queryFailed('BEGIN', $exception);
        }

        $this->transactionDepth = 1;

        try {
            $result = $work($this);
            $pdo->commit();

            return $result;
        } catch (\Throwable $exception) {
            // rollBack() itself can throw if the server already closed the
            // transaction (a DDL statement inside one commits implicitly on
            // MySQL). The original failure is the one worth reporting.
            try {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
            } catch (\PDOException) {
                // Deliberately swallowed; see above.
            }

            throw $exception;
        } finally {
            $this->transactionDepth = 0;
        }
    }

    /**
     * Runs read work against one explicit MySQL consistent snapshot.
     *
     * @template T
     * @param \Closure(self): T $work
     * @return T
     */
    public function consistentSnapshot(\Closure $work): mixed
    {
        if ($this->transactionDepth > 0) {
            throw new \LogicException('A consistent snapshot cannot start inside another transaction.');
        }

        $pdo = $this->pdo();

        try {
            $pdo->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        } catch (\PDOException $exception) {
            throw DatabaseException::queryFailed('START CONSISTENT SNAPSHOT', $exception);
        }

        $this->transactionDepth = 1;

        try {
            $result = $work($this);
            $pdo->commit();

            return $result;
        } catch (\Throwable $exception) {
            try {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
            } catch (\PDOException) {
            }

            throw $exception;
        } finally {
            $this->transactionDepth = 0;
        }
    }

    /**
     * @template T
     * @param \Closure(): T $work
     * @return T
     */
    public function withMutation(\Closure $work): mixed
    {
        return $this->snapshotLock === null ? $work() : $this->snapshotLock->withShared($work);
    }

    private static function mutates(string $sql): bool
    {
        $head = strtoupper((string) preg_replace('/^\s*(?:--[^\n]*\n\s*)*/', '', $sql));

        foreach (['INSERT ', 'UPDATE ', 'DELETE ', 'REPLACE ', 'CREATE ', 'ALTER ', 'DROP ', 'TRUNCATE '] as $verb) {
            if (str_starts_with($head, $verb)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The first few words of a statement, for a log line.
     *
     * Never the whole statement: a failing `INSERT` message that carried its SQL
     * would carry the values bound into it on an emulated driver, and even
     * un-emulated it is a schema disclosure in a place that does not need one.
     */
    private static function describeStatement(string $sql): string
    {
        $words = preg_split('/\s+/', trim($sql), 4) ?: [];

        return implode(' ', \array_slice($words, 0, 3));
    }
}
