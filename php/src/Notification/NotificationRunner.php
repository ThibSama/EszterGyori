<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Support\Logger;

/**
 * One cron tick (ESZ-071).
 *
 * The order of the four phases is the policy, not an implementation detail:
 *
 *  1. **Recover** expired leases, so a job stranded by a killed runner rejoins
 *     the queue before anything new is claimed.
 *  2. **Sweep** time-sensitive jobs whose window has closed, so a stale reminder
 *     is retired *before* it can be claimed and dispatched.
 *  3. **Claim** a bounded batch, one conditional UPDATE per candidate.
 *  4. **Deliver** each claimed job outside any transaction, writing its outcome
 *     as its own statement.
 *
 * Doing (2) before (3) is what makes the catch-up guarantee cheap: the sweep is
 * one indexed statement over `pending` rows and it runs whether or not there is
 * anything to deliver, so a backlog that accumulated while cron was down is
 * retired on the first tick after it comes back rather than being delivered.
 *
 * ## What this class never does
 *
 * It never opens a transaction around a transport call, never reads a customer
 * field, and never logs anything that did not come through
 * {@see NotificationLogContext}. The last of those is why the logger is used
 * only via `$this->log()`.
 */
final class NotificationRunner
{
    public function __construct(
        private readonly NotificationJobRepository $jobs,
        private readonly NotificationTransportRegistry $transports,
        private readonly EnabledChannels $channels,
        private readonly NotificationPolicy $policy,
        private readonly Logger $logger,
    ) {
    }

    /**
     * Builds the lease owner for this process.
     *
     * Host and pid, then a random tail. The random tail is the load-bearing part:
     * two runners on the same host in the same second must not be able to produce
     * the same owner, or the lease guard in `markSent()` would let one complete
     * the other's job. Host and pid are there only so an operator reading the
     * table can tell which process is stuck.
     */
    public static function ownerFor(string $host, int $pid): string
    {
        $host = strtolower(preg_replace('/[^a-zA-Z0-9]/', '-', $host) ?? 'host');
        $host = substr(trim($host, '-'), 0, 24);

        if ($host === '') {
            $host = 'host';
        }

        return \sprintf('%s.%d.%s', $host, $pid, bin2hex(random_bytes(6)));
    }

    /**
     * Runs one tick.
     *
     * @param int $batchSize How many jobs this tick may claim, bounded by the
     *                       frozen maximum.
     */
    public function run(string $owner, int $batchSize): NotificationRunResult
    {
        if ($batchSize < 1 || $batchSize > $this->policy->maxBatchSize) {
            throw NotificationException::invalid(
                'batchSize',
                "must be between 1 and {$this->policy->maxBatchSize}.",
            );
        }

        $enabled = $this->channels->enabledChannels();
        $missing = $this->transports->missing($enabled);

        if ($missing !== []) {
            // Refuse the whole run rather than claim jobs there is no way to
            // deliver. Claiming them would charge an attempt each and, five ticks
            // later, fail them terminally — losing real notifications to what is
            // only a configuration mistake.
            throw NotificationException::invalid(
                'transport',
                'no transport is registered for enabled channel(s): ' . implode(', ', $missing) . '.',
            );
        }

        $recovered = $this->jobs->recoverAbandonedLeases();
        $staleSkipped = $this->jobs->skipStaleTimeSensitiveJobs($this->policy->maxBatchSize);

        $claimed = $this->jobs->claimDue($owner, $batchSize, $enabled);

        $sent = 0;
        $retried = 0;
        $failed = 0;
        $skipped = 0;
        $leasesLost = 0;

        foreach ($claimed as $job) {
            switch ($this->deliver($job, $owner)) {
                case 'sent':
                    ++$sent;
                    break;
                case 'pending':
                    ++$retried;
                    break;
                case 'failed':
                    ++$failed;
                    break;
                case 'skipped':
                    ++$skipped;
                    break;
                default:
                    ++$leasesLost;
            }
        }

        $result = new NotificationRunResult(
            $recovered,
            $staleSkipped,
            \count($claimed),
            $sent,
            $retried,
            $failed,
            $skipped,
            $leasesLost,
        );

        $this->log('info', 'notification.run.completed', [
            'leaseOwner' => $owner,
            'batchSize' => $batchSize,
            'claimed' => \count($claimed),
            'recovered' => $recovered,
            'skipped' => $staleSkipped + $skipped,
        ]);

        return $result;
    }

    /**
     * Delivers one claimed job and records the outcome.
     *
     * The persisted database transition is authoritative: every guarded outcome
     * writer reports whether its UPDATE affected a row, and only a persisted
     * transition is counted, logged with its actual status, or returned. A
     * transport that succeeded is never reported as sent if the lease was lost
     * while it worked, and nothing is retried or rewritten after ownership loss.
     *
     * @return string The status that persisted (`sent`, `pending`, `failed`,
     *                `skipped`), or `lease_lost` when the job was no longer
     *                this runner's to write — nothing was persisted then, and
     *                the log line carries no status, because the row's current
     *                state belongs to whoever took the lease over.
     */
    private function deliver(NotificationJob $job, string $owner): string
    {
        // Re-checked after claiming as well as before: a batch can outlive its
        // own grace window while queued behind a slow transport, and the whole
        // point of the policy is that a reminder is never delivered late.
        if ($this->jobs->isStale($job)) {
            if ($this->jobs->markSkipped($job->id, $owner, 'reminder_window_expired')) {
                $this->logJob('info', 'notification.skipped', $job, [
                    'errorCode' => 'reminder_window_expired',
                    'status' => 'skipped',
                ]);

                return 'skipped';
            }

            return $this->leaseLost($job);
        }

        // ESZ-131: the delivery-time relevance re-check, before the transport
        // boundary. A lifecycle transition that committed after this job was
        // claimed (a move or cancellation that superseded only `pending` rows)
        // makes it obsolete; it is then terminally skipped with the frozen
        // supersession code — on the original attempt and on every retry — and
        // is never rendered with facts that no longer describe its event.
        $obsoleteCode = $this->jobs->obsoleteLifecycleCode($job);
        if ($obsoleteCode !== null) {
            if ($this->jobs->markSkipped($job->id, $owner, $obsoleteCode)) {
                $this->logJob('info', 'notification.skipped', $job, [
                    'errorCode' => $obsoleteCode,
                    'status' => 'skipped',
                ]);

                return 'skipped';
            }

            return $this->leaseLost($job);
        }

        $started = hrtime(true);

        try {
            $this->transports->get($job->channel)->deliver($job);
        } catch (TransientDeliveryException $exception) {
            return $this->recordTransientFailure($job, $owner, $exception->errorCode, $started);
        } catch (PermanentDeliveryException $exception) {
            if (!$this->jobs->markTerminalFailure($job, $owner, $exception->errorCode)) {
                // The lease expired while the transport was working and another
                // runner took the job. Reported, never rewritten: the new owner
                // is the one entitled to record an outcome.
                return $this->leaseLost($job, $started);
            }

            $this->logJob('warn', 'notification.failed', $job, [
                'errorCode' => $exception->errorCode,
                'status' => 'failed',
                'durationMs' => self::elapsedMs($started),
            ]);

            return 'failed';
        } catch (\Throwable $exception) {
            // A transport that throws something else is a transport bug, and its
            // message is untrusted — it may well carry the recipient address the
            // provider echoed back. It is classified, counted and discarded; the
            // class name is not written either, since a custom exception class
            // could be named after anything.
            unset($exception);

            return $this->recordTransientFailure($job, $owner, 'transport_transient', $started);
        }

        if (!$this->jobs->markSent($job, $owner)) {
            // The lease expired while the transport was working and another
            // runner took the job. Reported, never rewritten: the new owner is
            // the one entitled to record an outcome. A delivery the transport
            // really made is not a DB `sent` this runner is allowed to claim.
            return $this->leaseLost($job, $started);
        }

        $this->logJob('info', 'notification.sent', $job, [
            'status' => 'sent',
            'durationMs' => self::elapsedMs($started),
        ]);

        return 'sent';
    }

    /**
     * Records a transient failure and reports what actually persisted.
     *
     * The failure is a retry only when the row went back to `pending`. Once the
     * attempt budget is spent, the persisted outcome is terminal `failed` with
     * the frozen `attempts_exhausted` code — whatever the transport's transient
     * code was — and it is logged as the failure it is, never as a retry. A
     * null answer means the lease was lost, nothing was persisted, and the job
     * must not be retried or rewritten.
     */
    private function recordTransientFailure(
        NotificationJob $job,
        string $owner,
        string $errorCode,
        int|float $started,
    ): string {
        $status = $this->jobs->markTransientFailure($job, $owner, $errorCode);

        if ($status === null) {
            return $this->leaseLost($job, $started);
        }

        if ($status === 'failed') {
            $this->logJob('warn', 'notification.failed', $job, [
                'errorCode' => 'attempts_exhausted',
                'status' => 'failed',
                'durationMs' => self::elapsedMs($started),
            ]);

            return 'failed';
        }

        $this->logJob('warn', 'notification.retry', $job, [
            'errorCode' => $errorCode,
            'status' => 'pending',
            'durationMs' => self::elapsedMs($started),
        ]);

        return 'pending';
    }

    /**
     * Reports a lease lost between the claim and the outcome write.
     *
     * The row is no longer this runner's: whoever took the lease over may
     * already have delivered, retried or retired it, so the line must not
     * present the claim-time `processing` snapshot as the current state. The
     * status key is overridden to null — and dropped by the allowlist filter —
     * because the current DB status is unknown to this runner.
     */
    private function leaseLost(NotificationJob $job, int|float|null $started = null): string
    {
        $context = [
            'errorCode' => 'lease_lost',
            'status' => null,
        ];

        if ($started !== null) {
            $context['durationMs'] = self::elapsedMs($started);
        }

        $this->logJob('warn', 'notification.leaseLost', $job, $context);

        return 'lease_lost';
    }

    private static function elapsedMs(int|float $startedNs): int
    {
        return (int) round((hrtime(true) - $startedNs) / 1_000_000);
    }

    /** @param array<string, scalar|null> $context */
    private function logJob(string $level, string $message, NotificationJob $job, array $context): void
    {
        $this->logger->log(
            $level,
            $message,
            NotificationLogContext::forJob($job, $this->policy, $context),
        );
    }

    /** @param array<string, scalar|null> $context */
    private function log(string $level, string $message, array $context): void
    {
        $this->logger->log($level, $message, NotificationLogContext::filter($this->policy, $context));
    }
}
