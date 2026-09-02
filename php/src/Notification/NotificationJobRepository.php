<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/**
 * The durable queue itself (ESZ-070/071/072).
 *
 * ## Why claiming is a conditional UPDATE and not a transaction
 *
 * The obvious implementation is `SELECT … FOR UPDATE` inside a transaction that
 * stays open until delivery finishes. It is also the one that breaks: the
 * transaction would be held across an external call of unbounded duration, which
 * pins an InnoDB row lock and a connection for as long as a provider feels like
 * taking, and turns one slow SMTP handshake into a stalled queue.
 *
 * So the claim is a single statement:
 *
 *     UPDATE notification_jobs SET status='processing', lease_owner=…
 *      WHERE id=… AND status='pending' AND next_attempt_at_utc<=…
 *
 * InnoDB serialises the two concurrent versions of that statement on the row
 * lock, and the `status='pending'` predicate is re-evaluated after the wait. The
 * winner sees one affected row; the loser sees zero and moves on. That is the
 * whole mutual-exclusion argument, it commits immediately, and it holds across
 * processes and hosts because it is the database — not the runner — deciding.
 *
 * ## Why the lease is durable
 *
 * `lease_owner` and `lease_expires_at_utc` are columns. A runner killed between
 * the claim and the outcome leaves them behind; {@see recoverAbandonedLeases()}
 * returns the row to `pending` once the lease has expired. Attempts are *not*
 * reset, so a job that keeps killing its runner exhausts its budget and becomes
 * terminally failed instead of looping forever.
 *
 * ## Why success re-checks the lease
 *
 * {@see markSent()} is guarded on `lease_owner = :owner`. A runner whose lease
 * expired while a slow transport was working has already had the job taken from
 * it; recording a delivery at that point would race with the new owner and could
 * mark one job sent twice. The guard turns that into a detectable no-op, which
 * the runner reports as `lease_lost`.
 */
final class NotificationJobRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly NotificationPolicy $policy,
    ) {
    }

    /**
     * Records the intent to notify, exactly once per idempotency key.
     *
     * The `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` is not a no-op
     * dressed up: it is how MySQL is told to report the *existing* row's id from
     * `lastInsertId()` when the unique key collides. Without it the second
     * enqueue cannot tell which job it just resolved to, and the caller ends up
     * doing a second SELECT that a concurrent delete — or a concurrent insert of
     * a different key — could make lie.
     *
     * Nothing else about the existing row is touched. A repeated enqueue is a
     * repeated *intent*, not a reschedule: overwriting `next_attempt_at_utc`
     * would let a caller in a retry loop reset a job's backoff forever, and
     * overwriting a terminal status would resurrect something already decided.
     *
     * `$status` exists for the catch-up rules in {@see NotificationScheduler}: an
     * enqueue for a disabled channel or an already-expired reminder window is
     * stored directly as `skipped`, so the decision is recorded and there is no
     * backlog to flush later.
     */
    public function enqueue(
        int $bookingId,
        string $channel,
        string $jobType,
        string $idempotencyKey,
        \DateTimeImmutable $dueAt,
        string $status = 'pending',
        ?string $errorCode = null,
    ): int {
        $this->assertChannel($channel);
        $this->assertJobType($jobType);

        if (!$this->policy->acceptsIdempotencyKey($idempotencyKey)) {
            throw NotificationException::invalid('idempotencyKey', 'does not match the frozen key pattern.');
        }
        if ($status !== 'pending' && $status !== 'skipped') {
            throw NotificationException::invalid('status', 'an enqueue may only create a pending or skipped job.');
        }
        if ($errorCode !== null && !$this->policy->acceptsErrorCode($errorCode)) {
            throw NotificationException::invalid('errorCode', 'does not match the frozen code pattern.');
        }

        $now = $this->clock->nowIso();
        $due = NotificationInstant::database($dueAt);

        $this->database->run(
            'INSERT INTO notification_jobs ('
            . ' idempotency_key, booking_id, channel, job_type, due_at_utc, next_attempt_at_utc,'
            . ' status, attempts, last_error_code, created_at, updated_at, status_changed_at'
            . ') VALUES ('
            . ' :key, :booking, :channel, :type, :due, :next, :status, 0, :code,'
            . ' :createdAt, :updatedAt, :changedAt'
            . ') ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
            // Every placeholder is distinct even where the value repeats: with
            // `ATTR_EMULATE_PREPARES` off, a named placeholder used twice is sent
            // to MySQL as one parameter and the statement fails on the count.
            [
                'key' => $idempotencyKey,
                'booking' => $bookingId,
                'channel' => $channel,
                'type' => $jobType,
                'due' => $due,
                'next' => $due,
                'status' => $status,
                'code' => $errorCode,
                'createdAt' => $now,
                'updatedAt' => $now,
                'changedAt' => $now,
            ],
        );

        $id = (int) $this->database->pdo()->lastInsertId();

        // A key reused with different facts is a caller bug, not a duplicate.
        // Detecting it here is the difference between "the second enqueue was
        // ignored" — which is correct — and "the second enqueue silently
        // notified the wrong customer", which is what silence would hide.
        $stored = $this->database->fetchOne(
            'SELECT booking_id, channel, job_type FROM notification_jobs WHERE id = :id',
            ['id' => $id],
        );

        if ($stored === null) {
            throw new NotificationException('The enqueued notification job could not be read back.');
        }

        if (
            self::rowId($stored, 'booking_id') !== $bookingId
            || $stored['channel'] !== $channel
            || $stored['job_type'] !== $jobType
        ) {
            throw NotificationException::invalid(
                'idempotencyKey',
                'is already in use by a different booking, channel or type.',
            );
        }

        return $id;
    }

    /**
     * Returns expired leases to `pending` and reports how many were recovered.
     *
     * Run before claiming, so one tick both recovers and re-dispatches. Attempts
     * are left as they are: the claim already charged one, and forgiving it
     * would make a job that reliably kills its runner immortal.
     */
    public function recoverAbandonedLeases(): int
    {
        $now = $this->clock->now();

        $statement = $this->database->run(
            'UPDATE notification_jobs SET'
            . ' status = :pending, lease_owner = NULL, lease_expires_at_utc = NULL,'
            . ' last_error_code = :code, updated_at = :updatedAt, status_changed_at = :changedAt'
            . ' WHERE status = :processing AND lease_expires_at_utc <= :cutoff',
            [
                'pending' => 'pending',
                'processing' => 'processing',
                'code' => 'lease_expired',
                'updatedAt' => $this->clock->nowIso(),
                'changedAt' => $this->clock->nowIso(),
                'cutoff' => NotificationInstant::database($now),
            ],
        );

        return $statement->rowCount();
    }

    /**
     * Claims up to `$limit` due jobs for `$owner`.
     *
     * Two statements per candidate on purpose. The `SELECT` is an unlocked scan
     * that both runners may agree on; the `UPDATE` is the arbiter. Selecting
     * more candidates than needed and letting some claims lose is cheaper — and
     * far easier to reason about — than a `SELECT … FOR UPDATE SKIP LOCKED`
     * whose availability depends on the server version this shared host happens
     * to run.
     *
     * @param list<string> $channels Restricts the scan to channels that have a
     *                               transport; a channel with none is never
     *                               claimed rather than being claimed and failed.
     * @return list<NotificationJob>
     */
    public function claimDue(string $owner, int $limit, array $channels): array
    {
        if (!$this->policy->acceptsLeaseOwner($owner)) {
            throw NotificationException::invalid('leaseOwner', 'does not match the frozen owner pattern.');
        }
        if ($limit < 1 || $limit > $this->policy->maxBatchSize) {
            throw NotificationException::invalid(
                'batchSize',
                "must be between 1 and {$this->policy->maxBatchSize}.",
            );
        }
        if ($channels === []) {
            return [];
        }

        foreach ($channels as $channel) {
            $this->assertChannel($channel);
        }

        $now = $this->clock->now();
        $nowDatabase = NotificationInstant::database($now);
        $expiry = NotificationInstant::plusSeconds($now, $this->policy->leaseSeconds);
        $nowIso = $this->clock->nowIso();

        // Channel names are validated against the frozen enum immediately above,
        // so this interpolation can only ever produce `'email','sms'`. Bound
        // parameters are not usable inside `IN (…)` without building the same
        // list of placeholders, which is the same interpolation with more steps.
        $channelList = "'" . implode("','", $channels) . "'";

        $candidates = $this->database->fetchAll(
            'SELECT id FROM notification_jobs'
            . ' WHERE status = :pending AND next_attempt_at_utc <= :now'
            . " AND channel IN ({$channelList})"
            . ' ORDER BY next_attempt_at_utc, id LIMIT ' . $limit,
            ['pending' => 'pending', 'now' => $nowDatabase],
        );

        $claimed = [];

        foreach ($candidates as $candidate) {
            $id = self::rowId($candidate, 'id');
            if ($id === 0) {
                continue;
            }

            $statement = $this->database->run(
                'UPDATE notification_jobs SET'
                . ' status = :processing, lease_owner = :owner, lease_expires_at_utc = :expires,'
                . ' attempts = attempts + 1, updated_at = :updatedAt, status_changed_at = :changedAt'
                . ' WHERE id = :id AND status = :pending AND next_attempt_at_utc <= :cutoff'
                . ' AND attempts < :maxAttempts',
                [
                    'processing' => 'processing',
                    'owner' => $owner,
                    'expires' => $expiry,
                    'updatedAt' => $nowIso,
                    'changedAt' => $nowIso,
                    'id' => $id,
                    'pending' => 'pending',
                    'cutoff' => $nowDatabase,
                    'maxAttempts' => $this->policy->maxAttempts,
                ],
            );

            // Zero affected rows means another runner won the race, or the job
            // stopped being due between the scan and the update. Both are
            // ordinary; neither is an error.
            if ($statement->rowCount() !== 1) {
                continue;
            }

            $job = $this->find($id);
            if ($job !== null) {
                $claimed[] = $job;
            }
        }

        return $claimed;
    }

    /**
     * Marks one delivery done, once.
     *
     * Guarded on the owner as well as the status: see the class docblock. Returns
     * false when the job was no longer this runner's to complete, which the
     * caller reports rather than retries.
     */
    public function markSent(NotificationJob $job, string $owner): bool
    {
        $now = $this->clock->now();

        $statement = $this->database->run(
            'UPDATE notification_jobs SET'
            . ' status = :sent, sent_at_utc = :sentAt, lease_owner = NULL, lease_expires_at_utc = NULL,'
            . ' last_error_code = NULL, updated_at = :updatedAt, status_changed_at = :changedAt'
            . ' WHERE id = :id AND status = :processing AND lease_owner = :owner',
            [
                'sent' => 'sent',
                'sentAt' => NotificationInstant::database($now),
                'updatedAt' => $this->clock->nowIso(),
                'changedAt' => $this->clock->nowIso(),
                'id' => $job->id,
                'processing' => 'processing',
                'owner' => $owner,
            ],
        );

        return $statement->rowCount() === 1;
    }

    /**
     * Records a transient failure: back to `pending` with backoff, or terminal
     * `failed` once the attempt budget is spent.
     *
     * The exhaustion check reads the attempt count charged by the claim, so the
     * fifth failure is terminal rather than scheduling a sixth attempt the
     * `chk_notification_jobs_attempts` constraint would refuse anyway.
     *
     * @return string The status actually written.
     */
    public function markTransientFailure(NotificationJob $job, string $owner, string $errorCode): string
    {
        $this->assertErrorCode($errorCode);

        if ($this->policy->attemptsExhausted($job->attempts)) {
            $this->markTerminalFailure($job, $owner, 'attempts_exhausted');

            return 'failed';
        }

        $now = $this->clock->now();
        $delay = $this->policy->backoffSeconds($job->attempts);

        $this->database->run(
            'UPDATE notification_jobs SET'
            . ' status = :pending, lease_owner = NULL, lease_expires_at_utc = NULL,'
            . ' next_attempt_at_utc = :next, last_error_code = :code,'
            . ' updated_at = :updatedAt, status_changed_at = :changedAt'
            . ' WHERE id = :id AND status = :processing AND lease_owner = :owner',
            [
                'pending' => 'pending',
                'next' => NotificationInstant::plusSeconds($now, $delay),
                'code' => $errorCode,
                'updatedAt' => $this->clock->nowIso(),
                'changedAt' => $this->clock->nowIso(),
                'id' => $job->id,
                'processing' => 'processing',
                'owner' => $owner,
            ],
        );

        return 'pending';
    }

    /** Terminal failure: a permanent refusal, or a spent attempt budget. */
    public function markTerminalFailure(NotificationJob $job, string $owner, string $errorCode): bool
    {
        $this->assertErrorCode($errorCode);

        return $this->markTerminal($job->id, 'failed', $owner, $errorCode);
    }

    /**
     * Terminal skip: considered, deliberately not sent.
     *
     * `$owner` is null when the job was swept while still `pending` — the
     * catch-up sweep never claims — and set when a claimed job turned out to be
     * stale after all.
     */
    public function markSkipped(int $jobId, ?string $owner, string $errorCode): bool
    {
        $this->assertErrorCode($errorCode);

        return $this->markTerminal($jobId, 'skipped', $owner, $errorCode);
    }

    /**
     * Terminally supersedes pending reminders for one booking occurrence.
     * Sent and processing jobs are immutable here: they are already history or
     * already owned by a runner, so a lifecycle transaction must not rewrite them.
     */
    public function supersedePendingReminders(
        int $bookingId,
        string $errorCode,
        ?\DateTimeImmutable $dueAt = null,
    ): int {
        $this->assertErrorCode($errorCode);
        $sql = 'UPDATE notification_jobs SET status = :skipped, last_error_code = :code,'
            . ' updated_at = :updatedAt, status_changed_at = :changedAt'
            . ' WHERE booking_id = :booking AND channel = :channel'
            . ' AND job_type = :type AND status = :pending';
        $parameters = [
            'skipped' => 'skipped',
            'code' => $errorCode,
            'updatedAt' => $this->clock->nowIso(),
            'changedAt' => $this->clock->nowIso(),
            'booking' => $bookingId,
            'channel' => 'email',
            'type' => 'booking_reminder',
            'pending' => 'pending',
        ];
        if ($dueAt !== null) {
            $sql .= ' AND due_at_utc = :due';
            $parameters['due'] = NotificationInstant::database($dueAt);
        }

        return $this->database->run($sql, $parameters)->rowCount();
    }

    private function markTerminal(int $jobId, string $status, ?string $owner, string $errorCode): bool
    {
        $parameters = [
            'status' => $status,
            'code' => $errorCode,
            'updatedAt' => $this->clock->nowIso(),
            'changedAt' => $this->clock->nowIso(),
            'id' => $jobId,
        ];

        if ($owner === null) {
            // Swept before any claim: the row must still be pending, or someone
            // else already decided its fate and this sweep must not overwrite it.
            $sql = 'UPDATE notification_jobs SET'
                . ' status = :status, lease_owner = NULL, lease_expires_at_utc = NULL,'
                . ' last_error_code = :code, updated_at = :updatedAt, status_changed_at = :changedAt'
                . ' WHERE id = :id AND status = :pending';
            $parameters['pending'] = 'pending';
        } else {
            $sql = 'UPDATE notification_jobs SET'
                . ' status = :status, lease_owner = NULL, lease_expires_at_utc = NULL,'
                . ' last_error_code = :code, updated_at = :updatedAt, status_changed_at = :changedAt'
                . ' WHERE id = :id AND status = :processing AND lease_owner = :owner';
            $parameters['processing'] = 'processing';
            $parameters['owner'] = $owner;
        }

        return $this->database->run($sql, $parameters)->rowCount() === 1;
    }

    /**
     * Terminally retires every non-terminal job of one booking (ESZ-140).
     *
     * Written by customer-data retention, in the same transaction as the
     * booking erasure. `pending` and `processing` become `retired` with the
     * frozen retention code; a processing job's lease is cleared by the same
     * update, so the runner that held it can no longer record an outcome
     * (`markSent` and the failure writers are all guarded on
     * `status = 'processing'`). Terminal jobs — `sent`, `failed`, `skipped` —
     * are delivery evidence and are deliberately not matched.
     *
     * The status guard makes the method idempotent: a second call finds no
     * pending or processing rows and retires nothing.
     */
    public function retireForBooking(int $bookingId, string $errorCode): int
    {
        $this->assertErrorCode($errorCode);

        return $this->database->run(
            'UPDATE notification_jobs SET'
            . ' status = :retired, lease_owner = NULL, lease_expires_at_utc = NULL,'
            . ' last_error_code = :code, updated_at = :updatedAt, status_changed_at = :changedAt'
            . ' WHERE booking_id = :booking AND status IN (:pending, :processing)',
            [
                'retired' => 'retired',
                'code' => $errorCode,
                'updatedAt' => $this->clock->nowIso(),
                'changedAt' => $this->clock->nowIso(),
                'booking' => $bookingId,
                'pending' => 'pending',
                'processing' => 'processing',
            ],
        )->rowCount();
    }

    /**
     * Terminally skips every pending time-sensitive job whose window has closed.
     *
     * One statement, no claim, no lease: a stale reminder is not being delivered
     * by anyone, so there is nothing to coordinate with. Bounded by `$limit` for
     * the same reason the claim is — a recovered backlog is drained across ticks.
     */
    public function skipStaleTimeSensitiveJobs(int $limit): int
    {
        if ($this->policy->timeSensitiveJobTypes === []) {
            return 0;
        }

        $cutoff = NotificationInstant::minusMinutes(
            $this->clock->now(),
            $this->policy->reminderGraceMinutes,
        );

        // Frozen enum values from the artifact; see claimDue() for why the list
        // is interpolated rather than bound.
        $typeList = "'" . implode("','", $this->policy->timeSensitiveJobTypes) . "'";

        $stale = $this->database->fetchAll(
            'SELECT id FROM notification_jobs'
            . " WHERE status = :pending AND job_type IN ({$typeList}) AND due_at_utc < :cutoff"
            . ' ORDER BY due_at_utc, id LIMIT ' . max(1, $limit),
            ['pending' => 'pending', 'cutoff' => $cutoff],
        );

        $skipped = 0;
        foreach ($stale as $row) {
            $id = self::rowId($row, 'id');
            if ($id !== 0 && $this->markSkipped($id, null, 'reminder_window_expired')) {
                ++$skipped;
            }
        }

        return $skipped;
    }

    /**
     * Whether this job's window has closed, asked of an already-claimed job.
     *
     * The sweep above cannot be the only check. A batch claimed at the start of a
     * tick can still be waiting behind a slow transport when the grace window
     * closes, and delivering it then would be exactly the late reminder the
     * policy exists to prevent.
     */
    public function isStale(NotificationJob $job): bool
    {
        if (!$this->policy->isTimeSensitive($job->jobType)) {
            return false;
        }

        $cutoff = NotificationInstant::minusMinutes(
            $this->clock->now(),
            $this->policy->reminderGraceMinutes,
        );

        return $job->dueAtUtc < $cutoff;
    }

    public function find(int $id): ?NotificationJob
    {
        $row = $this->database->fetchOne(
            'SELECT j.*, b.reference FROM notification_jobs j'
            . ' JOIN bookings b ON b.id = j.booking_id WHERE j.id = :id',
            ['id' => $id],
        );

        return $row === null ? null : NotificationJob::fromRow($row);
    }

    public function findByIdempotencyKey(string $key): ?NotificationJob
    {
        $row = $this->database->fetchOne(
            'SELECT j.*, b.reference FROM notification_jobs j'
            . ' JOIN bookings b ON b.id = j.booking_id WHERE j.idempotency_key = :key',
            ['key' => $key],
        );

        return $row === null ? null : NotificationJob::fromRow($row);
    }

    /** @return list<NotificationJob> */
    public function forBooking(int $bookingId): array
    {
        return array_map(
            static fn (array $row): NotificationJob => NotificationJob::fromRow($row),
            $this->database->fetchAll(
                'SELECT j.*, b.reference FROM notification_jobs j'
                . ' JOIN bookings b ON b.id = j.booking_id'
                . ' WHERE j.booking_id = :booking ORDER BY j.id',
                ['booking' => $bookingId],
            ),
        );
    }

    /**
     * Reads one integer column without trusting the driver to have typed it.
     *
     * `ATTR_STRINGIFY_FETCHES` is off, so a `BIGINT UNSIGNED` arrives as an int;
     * this exists so that a driver, host or column type that ever stops doing
     * that fails here rather than silently comparing an int to a numeric string.
     *
     * @param array<string, mixed> $row
     */
    private static function rowId(array $row, string $column): int
    {
        $value = $row[$column] ?? null;

        if (\is_int($value)) {
            return $value;
        }

        if (\is_string($value) && preg_match('/^\d{1,19}$/D', $value) === 1) {
            return (int) $value;
        }

        throw new NotificationException("notification_jobs.{$column} is not an identifier.");
    }

    private function assertChannel(string $channel): void
    {
        if (!$this->policy->acceptsChannel($channel)) {
            throw NotificationException::invalid('channel', "`{$channel}` is not a frozen channel.");
        }
    }

    private function assertJobType(string $jobType): void
    {
        if (!$this->policy->acceptsJobType($jobType)) {
            throw NotificationException::invalid('jobType', "`{$jobType}` is not a frozen job type.");
        }
    }

    private function assertErrorCode(string $code): void
    {
        if (!$this->policy->acceptsErrorCode($code)) {
            throw NotificationException::invalid('errorCode', 'does not match the frozen code pattern.');
        }
    }
}
