<?php

declare(strict_types=1);

namespace Eszter\Security;

use Eszter\Database\Database;
use Eszter\Database\DatabaseException;
use Eszter\Support\Clock;
use Eszter\Support\Logger;

/**
 * GCRA over `rate_limit_buckets` (ESZ-084).
 *
 * ## The algorithm, in one paragraph
 *
 * Each bucket stores one instant, the *theoretical arrival time*: when the bucket
 * will next be exactly at its long-run rate. A request is admitted when that
 * instant is no further ahead than the burst allowance —
 * `tat <= now + delayTolerance` — and admission pushes it forward by one emission
 * interval. A bucket that is idle falls behind `now`, which is what restores
 * allowance, and `max(tat, now)` is what stops idleness from accumulating credit
 * without bound. There is no window, so there is no window boundary across which
 * twice the limit can arrive.
 *
 * ## Why the decision is two statements and not a transaction
 *
 * The obvious implementation is `SELECT ... FOR UPDATE`, compute in PHP, `UPDATE`,
 * commit. It is also wrong here, and not subtly: the routes that call this open
 * their own transactions, and PHP's nesting counter would fold the limiter's
 * transaction into the caller's — so a booking that rolled back would roll back
 * the allowance it had just spent, and a script could retry forever at zero cost.
 * A limiter whose charge is undone by the failure it was meant to bound is not a
 * limiter.
 *
 * So the charge is never transactional. It is at most two autocommitted
 * statements, each atomic on its own:
 *
 *  1. `INSERT ... ON DUPLICATE KEY UPDATE` with a condition that makes the update
 *     a no-op when the bucket is out of allowance. MySQL takes the row lock for
 *     the duration of the statement, so two processes presenting the last
 *     allowance are serialised by the engine rather than by anything this code
 *     does.
 *  2. A single `SELECT` of the resulting arrival time, used only to compute
 *     `Retry-After` — and only on the refusal path, so an admitted request costs
 *     exactly one round trip.
 *
 * Admission is read from the statement's own affected-row count rather than from
 * a follow-up read, which is the part that has to be race-free. See
 * {@see admitted()} for why that count means what it means.
 *
 * ## The clock is injected, and the database's is never consulted
 *
 * Every instant in the statement is a bound parameter computed in PHP. `NOW(3)`
 * would have been shorter and would have made the whole rule untestable: a suite
 * cannot move the database's clock, so every assertion about backoff would have
 * become a `sleep()`. `rateLimitPolicy.clock` freezes this as `application`.
 *
 * ## Failing closed
 *
 * A database error refuses the request. The alternative — admitting on failure —
 * turns any way of making the limiter throw into a way of switching it off, which
 * is the first thing worth attacking about a limiter. The failure is logged with
 * its scope and nothing else.
 */
final class PdoRateLimiter implements RateLimiter
{
    /**
     * How often, in charges, the expired-row sweep runs.
     *
     * Probabilistic rather than scheduled: the deployment's cron entries are
     * owned by notifications and by customer-data retention, so a limiter
     * that needed its own would not get one. One in this many charges pays
     * for a bounded `DELETE`;
     * the rest pay nothing. Sweeping is pure housekeeping — a row that survives
     * too long enforces the policy correctly, and one deleted early only forgives
     * allowance — so it is safe to leave to chance.
     */
    private const SWEEP_ONE_IN = 200;

    /** Rows one sweep may remove. Bounded so housekeeping cannot become the request. */
    private const SWEEP_BATCH = 500;

    public function __construct(
        private readonly Database $database,
        private readonly RateLimitPolicy $policy,
        private readonly Clock $clock,
        private readonly Logger $logger,
    ) {
    }

    public function charge(string $scope, string $subject): RateLimitDecision
    {
        $rule = $this->policy->rule($scope);
        $key = self::bucketKey($scope, $subject);
        $now = self::milliseconds($this->clock->now());

        try {
            $admitted = $this->admit($rule, $key, $now);

            if ($admitted) {
                $this->sweepOccasionally($now);

                return RateLimitDecision::allowed($scope);
            }

            return RateLimitDecision::refused($scope, $this->retryAfterMs($rule, $key, $now));
        } catch (DatabaseException $exception) {
            // Fails closed. `logContext()` is already scrubbed of credentials, and
            // the subject is not in it: the scope is what an operator needs and
            // the caller's address is not this file's to record.
            $this->logger->error('Rate limiter unavailable; refusing the request.', [
                'scope' => $scope,
                'reason' => $exception->getMessage(),
            ]);

            return RateLimitDecision::refused($scope, $rule->emissionIntervalMs);
        }
    }

    /**
     * The one statement that both decides and records.
     *
     * The `ON DUPLICATE KEY UPDATE` list is ordered deliberately. MySQL evaluates
     * assignments left to right and later ones see the values earlier ones just
     * wrote, so `expires_at_ms` is computed *before* `tat_ms` is overwritten —
     * reversing the two lines would silently derive the expiry from the new
     * arrival time and quietly extend every row's retention.
     *
     * Both assignments are guarded by the same admission condition through `IF`,
     * so a refused charge writes nothing at all: it must not push the arrival
     * time further out, or a caller who keeps hammering a full bucket would
     * lengthen their own penalty without limit.
     */
    private function admit(RateLimitRule $rule, string $key, int $now): bool
    {
        $admissible = $now + $rule->delayToleranceMs;
        $freshTat = $now + $rule->emissionIntervalMs;

        $statement = $this->database->run(
            'INSERT INTO rate_limit_buckets (bucket_key, scope, tat_ms, expires_at_ms)'
            . ' VALUES (:key, :scope, :fresh_tat, :fresh_expires)'
            . ' ON DUPLICATE KEY UPDATE'
            // Expiry first; see the method note.
            . '  expires_at_ms = IF(tat_ms <= :admissible_a,'
            . '    GREATEST(tat_ms, :now_a) + :emission_a + :retention, expires_at_ms),'
            . '  tat_ms = IF(tat_ms <= :admissible_b,'
            . '    GREATEST(tat_ms, :now_b) + :emission_b, tat_ms)',
            [
                'key' => $key,
                'scope' => $rule->scope,
                'fresh_tat' => $freshTat,
                'fresh_expires' => $freshTat + $rule->retentionMs(),
                // Each placeholder is used exactly once. With ATTR_EMULATE_PREPARES
                // off, PDO rewrites named parameters positionally for the server
                // and reusing a name is "Invalid parameter number" — the same
                // constraint PdoSessionStore documents.
                'admissible_a' => $admissible,
                'admissible_b' => $admissible,
                'now_a' => $now,
                'now_b' => $now,
                'emission_a' => $rule->emissionIntervalMs,
                'emission_b' => $rule->emissionIntervalMs,
                'retention' => $rule->retentionMs(),
            ],
        );

        return self::admitted($statement->rowCount());
    }

    /**
     * Reads admission out of MySQL's affected-row count.
     *
     * For `INSERT ... ON DUPLICATE KEY UPDATE` the count is 1 for a row that was
     * inserted, 2 for a row that was updated *and actually changed*, and 0 for a
     * row the statement matched but left byte-identical. That last case is
     * exactly a refusal: both `IF`s evaluated false and wrote the existing values
     * back.
     *
     * The mapping is only sound because an admitted charge always changes
     * `tat_ms`. It does: the new value is `GREATEST(tat, now) + emission` with a
     * strictly positive emission interval, so it is strictly greater than the old
     * one, and {@see RateLimitRule::create()} refuses a zero interval. Without
     * that guarantee an admitted charge could write an unchanged row and be
     * misread as a refusal.
     */
    private static function admitted(int $affectedRows): bool
    {
        return $affectedRows !== 0;
    }

    /**
     * How long until this bucket would admit again.
     *
     * Only reached on a refusal, so an admitted request never pays for it. Read
     * outside the deciding statement on purpose: it informs a header, and a stale
     * value can only ever suggest waiting slightly too long, which costs a caller
     * one retry and costs the server nothing. Buying exactness here would mean
     * holding a lock across two statements to improve a hint.
     */
    private function retryAfterMs(RateLimitRule $rule, string $key, int $now): int
    {
        $row = $this->database->fetchOne(
            'SELECT tat_ms FROM rate_limit_buckets WHERE bucket_key = :key',
            ['key' => $key],
        );

        /** @var mixed $tat */
        $tat = $row['tat_ms'] ?? null;

        if (!\is_int($tat)) {
            // The row was swept between the two statements, so the bucket is
            // empty and the caller may retry at once. One emission interval is
            // still the honest floor: less would be admitted only by luck.
            return $rule->emissionIntervalMs;
        }

        return max($rule->emissionIntervalMs, $tat - $rule->delayToleranceMs - $now);
    }

    /**
     * Deletes a bounded batch of dead rows, occasionally.
     *
     * Swallows its own failures: a sweep that cannot run is a table that grows,
     * not a request that fails, and turning housekeeping into a 429 would be the
     * limiter attacking the site on the sweeper's behalf.
     */
    private function sweepOccasionally(int $now): void
    {
        if (random_int(1, self::SWEEP_ONE_IN) !== 1) {
            return;
        }

        try {
            $this->database->run(
                'DELETE FROM rate_limit_buckets WHERE expires_at_ms < :now'
                . ' ORDER BY expires_at_ms LIMIT ' . self::SWEEP_BATCH,
                ['now' => $now],
            );
        } catch (DatabaseException $exception) {
            $this->logger->warn('Rate limit sweep failed; buckets were not pruned.', [
                'reason' => $exception->getMessage(),
            ]);
        }
    }

    /**
     * The stored key: raw sha256 of the scope and the subject, NUL-separated.
     *
     * The separator is what keeps the scopes from colliding. Concatenated plainly,
     * scope `a` with subject `bc` and scope `ab` with subject `c` hash to the same
     * bucket, and two unrelated rules would silently share an allowance. NUL
     * cannot occur in a scope — the column's CHECK constraint forbids it — so the
     * split is unambiguous.
     *
     * Raw bytes, not hex: the column is `BINARY(32)` and hex would double the
     * index without adding anything. Nothing ever reverses this value; it is only
     * ever compared.
     */
    private static function bucketKey(string $scope, string $subject): string
    {
        return hash('sha256', $scope . "\0" . $subject, true);
    }

    /** Whole milliseconds since the Unix epoch, for arithmetic in SQL. */
    private static function milliseconds(\DateTimeImmutable $instant): int
    {
        return (int) $instant->format('U') * 1000 + (int) $instant->format('v');
    }
}
