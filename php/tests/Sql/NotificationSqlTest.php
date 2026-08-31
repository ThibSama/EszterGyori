<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Database\Database;
use Eszter\Notification\LoggingNotificationTransport;
use Eszter\Notification\NotificationCatchUpPolicy;
use Eszter\Notification\NotificationChannelSettings;
use Eszter\Notification\NotificationException;
use Eszter\Notification\NotificationJob;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\NotificationPolicy;
use Eszter\Notification\NotificationRunner;
use Eszter\Notification\NotificationScheduler;
use Eszter\Notification\NotificationTransport;
use Eszter\Notification\NotificationTransportRegistry;
use Eszter\Notification\PermanentDeliveryException;
use Eszter\Notification\TransientDeliveryException;
use Eszter\Support\Logger;
use Eszter\Tests\MovableClock;
use Eszter\Tests\Notification\FixedEnabledChannels;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/**
 * The `sql:notifications` gate (ESZ-070 / ESZ-071 / ESZ-072).
 *
 * Its own suite because it is its own gate, and against real MySQL because
 * almost nothing it asserts is true on anything else. The claim is a conditional
 * `UPDATE` whose correctness rests on InnoDB re-evaluating the `WHERE` clause
 * after waiting on a row lock; the idempotent enqueue rests on
 * `ON DUPLICATE KEY UPDATE … LAST_INSERT_ID(id)`; the constraint refusals rest on
 * MySQL enforcing `CHECK`. A SQLite run would be green and would prove none of
 * it.
 *
 * ## Isolation
 *
 * Most tests roll back. The two concurrency proofs cannot — an independent
 * process must be able to see the fixture — so they commit, and clean up with
 * `truncateData()` on the way in.
 */
#[Group('sql')]
final class NotificationSqlTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const REFERENCE = 'bk_11111111111111111111111111111111';

    private static bool $migrated = false;

    private Database $database;
    private MovableClock $clock;
    private NotificationPolicy $policy;
    private NotificationJobRepository $jobs;
    private FixedEnabledChannels $channels;
    private string $root;
    private string $logPath;
    private Logger $logger;

    protected function setUp(): void
    {
        if (!TestDatabase::isConfigured()) {
            self::markTestSkipped(TestDatabase::skipReason());
        }

        $this->database = TestDatabase::connect();

        if (!self::$migrated) {
            TestDatabase::dropEverything($this->database);
            TestDatabase::migrator($this->database)->migrate();
            self::$migrated = true;
        }

        TestDatabase::truncateData($this->database);

        $this->clock = new MovableClock(self::NOW);
        $this->policy = NotificationPolicy::fromArtifacts(TestEnvironment::artifacts());
        $this->jobs = new NotificationJobRepository($this->database, $this->clock, $this->policy);
        $this->channels = new FixedEnabledChannels(['email']);
        $this->root = TestEnvironment::makeTempDirectory('eszter-notify');
        $this->logPath = $this->root . '/notifications.log';
        $this->logger = new Logger($this->logPath, 'debug', $this->clock);

        $this->database->beginTransaction();
    }

    protected function tearDown(): void
    {
        if (isset($this->database) && $this->database->inTransaction()) {
            $this->database->rollBack();
        }

        if (isset($this->root)) {
            TestEnvironment::removeDirectory($this->root);
        }
    }

    // --- ESZ-070: identity and constraints ---------------------------------

    public function testARepeatedEnqueueResolvesToTheSameLogicalJob(): void
    {
        $bookingId = $this->seedBooking();
        $due = $this->clock->now()->modify('+1 day');

        $first = $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'idem.key.one', $due);
        $second = $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'idem.key.one', $due);

        self::assertSame($first, $second, 'a duplicate enqueue created a second job');
        self::assertSame(1, $this->rowCount('SELECT COUNT(*) AS n FROM notification_jobs'));

        // And the second call did not reschedule the first. A caller in a retry
        // loop must not be able to push a job's next attempt forward forever.
        $this->clock->advanceMinutes(30);
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'idem.key.one', $due->modify('+3 days'));

        $job = $this->jobs->find($first);
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame($this->databaseTime($due), $job->dueAtUtc);
        self::assertSame($this->databaseTime($due), $job->nextAttemptAtUtc);
        self::assertSame(1, $this->rowCount('SELECT COUNT(*) AS n FROM notification_jobs'));
    }

    public function testAKeyReusedForDifferentFactsIsRefusedRatherThanSilentlyIgnored(): void
    {
        $bookingId = $this->seedBooking();
        $other = $this->seedBooking('bk_22222222222222222222222222222222');
        $due = $this->clock->now()->modify('+1 day');

        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'shared.key.value', $due);

        // Same key, different booking. Silence here would mean the second
        // customer's notification was quietly dropped — or worse, that the first
        // customer's job now stands in for it.
        $this->expectException(NotificationException::class);
        $this->expectExceptionMessageMatches('/already in use/');
        $this->jobs->enqueue($other, 'email', 'booking_confirmation', 'shared.key.value', $due);
    }

    public function testMalformedIdentityChannelTypeAndCodeAreAllRefused(): void
    {
        $bookingId = $this->seedBooking();
        $due = $this->clock->now();

        $key = 'a.valid.key.here';

        $refusals = [
            'short key' => fn () => $this->jobs
                ->enqueue($bookingId, 'email', 'booking_confirmation', 'short', $due),
            'unknown channel' => fn () => $this->jobs
                ->enqueue($bookingId, 'pigeon', 'booking_confirmation', $key, $due),
            'unknown type' => fn () => $this->jobs
                ->enqueue($bookingId, 'email', 'booking_haiku', $key, $due),
            'non-terminal status' => fn () => $this->jobs
                ->enqueue($bookingId, 'email', 'booking_confirmation', $key, $due, 'sent'),
            'error message not code' => fn () => $this->jobs->enqueue(
                $bookingId,
                'email',
                'booking_confirmation',
                $key,
                $due,
                'skipped',
                'smtp 550 cliente@example.test',
            ),
        ];

        foreach ($refusals as $label => $operation) {
            try {
                $operation();
                self::fail("{$label} was accepted");
            } catch (NotificationException) {
                self::addToAssertionCount(1);
            }
        }

        self::assertSame(0, $this->rowCount('SELECT COUNT(*) AS n FROM notification_jobs'));
    }

    // --- ESZ-071: claiming, leases, retries --------------------------------

    public function testAClaimTakesALeaseChargesAnAttemptAndIsNotVisibleToASecondClaim(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'claim.key.value', $this->clock->now());

        $first = $this->jobs->claimDue($this->owner('one'), 10, ['email']);
        self::assertCount(1, $first);
        self::assertSame('processing', $first[0]->status);
        self::assertSame(1, $first[0]->attempts);
        self::assertNotNull($first[0]->leaseOwner);
        self::assertNotNull($first[0]->leaseExpiresAtUtc);

        // The second runner, on the same connection, sees nothing to claim. This
        // is the ordinary path; the two-process proof below is the hard one.
        self::assertSame([], $this->jobs->claimDue($this->owner('two'), 10, ['email']));
    }

    public function testAJobThatIsNotYetDueIsNeverClaimed(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue(
            $bookingId,
            'email',
            'booking_confirmation',
            'future.key.value',
            $this->clock->now()->modify('+1 hour'),
        );

        self::assertSame([], $this->jobs->claimDue($this->owner('one'), 10, ['email']));

        $this->clock->advanceMinutes(61);
        self::assertCount(1, $this->jobs->claimDue($this->owner('one'), 10, ['email']));
    }

    public function testAChannelWithNoTransportIsNeverClaimed(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'sms', 'booking_confirmation', 'sms.key.value', $this->clock->now());

        // Claiming it would charge an attempt and, five ticks later, fail a real
        // notification over a configuration mistake.
        self::assertSame([], $this->jobs->claimDue($this->owner('one'), 10, ['email']));
        self::assertCount(1, $this->jobs->claimDue($this->owner('one'), 10, ['email', 'sms']));
    }

    public function testDeliverySucceedsExactlyOnceAndTheJobIsTerminal(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'sent.key.value', $this->clock->now());

        $transport = new RecordingTransport('email');
        $result = $this->runner($transport)->run($this->owner('one'), 10);

        self::assertSame(1, $result->claimed);
        self::assertSame(1, $result->sent);
        self::assertSame(1, $transport->delivered);

        $job = $this->jobs->findByIdempotencyKey('sent.key.value');
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame('sent', $job->status);
        self::assertNotNull($job->sentAtUtc);
        self::assertNull($job->leaseOwner);
        self::assertSame(1, $job->attempts);

        // A second tick finds nothing: `sent` is terminal, so no amount of cron
        // can deliver it twice.
        $second = $this->runner($transport)->run($this->owner('two'), 10);
        self::assertSame(0, $second->claimed);
        self::assertSame(1, $transport->delivered);
    }

    public function testATransientFailureRetriesWithTheFrozenBackoffUntilTheBudgetIsSpent(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'retry.key.value', $this->clock->now());

        $transport = new FailingTransport('email', new TransientDeliveryException('transport_transient'));
        $delays = [];

        for ($attempt = 1; $attempt <= $this->policy->maxAttempts; ++$attempt) {
            $result = $this->runner($transport)->run($this->owner('one'), 10);
            self::assertSame(1, $result->claimed, "attempt {$attempt} did not claim");

            $job = $this->jobs->findByIdempotencyKey('retry.key.value');
            self::assertInstanceOf(NotificationJob::class, $job);
            self::assertSame($attempt, $job->attempts);

            if ($attempt < $this->policy->maxAttempts) {
                self::assertSame('pending', $job->status);
                self::assertSame(1, $result->retried);
                $delays[] = $this->secondsBetween($this->clock->now(), $job->nextAttemptAtUtc);
                // Nothing is claimable until the backoff has elapsed.
                self::assertSame([], $this->jobs->claimDue($this->owner('two'), 10, ['email']));
                $this->clock->advanceSeconds($this->policy->backoffSeconds($attempt) + 1);
            } else {
                self::assertSame('failed', $job->status);
                self::assertSame(1, $result->failed);
                self::assertSame('attempts_exhausted', $job->lastErrorCode);
            }
        }

        self::assertSame([60, 120, 240, 480], $delays);
        self::assertSame($this->policy->maxAttempts, $transport->attempted);

        // Terminal means terminal: no later tick picks it up again.
        $this->clock->advanceSeconds($this->policy->maxBackoffSeconds * 10);
        self::assertSame(0, $this->runner($transport)->run($this->owner('three'), 10)->claimed);
        self::assertSame($this->policy->maxAttempts, $transport->attempted);
    }

    public function testAPermanentRefusalIsTerminalOnTheFirstAttempt(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'perm.key.value', $this->clock->now());

        $transport = new FailingTransport('email', new PermanentDeliveryException('transport_permanent'));
        $result = $this->runner($transport)->run($this->owner('one'), 10);

        self::assertSame(1, $result->failed);

        $job = $this->jobs->findByIdempotencyKey('perm.key.value');
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame('failed', $job->status);
        self::assertSame(1, $job->attempts, 'a permanent refusal must not spend the whole budget');
        self::assertSame('transport_permanent', $job->lastErrorCode);
    }

    public function testATransportThrowingSomethingUnexpectedIsTreatedAsTransientAndItsMessageIsDiscarded(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'boom.key.value', $this->clock->now());

        $leak = 'SMTP said 550 for cliente@example.test';
        $this->runner(new FailingTransport('email', new \RuntimeException($leak)))
            ->run($this->owner('one'), 10);

        $job = $this->jobs->findByIdempotencyKey('boom.key.value');
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame('pending', $job->status);
        self::assertSame('transport_transient', $job->lastErrorCode);

        self::assertStringNotContainsString('cliente@example.test', $this->logContents());
        self::assertStringNotContainsString('550', $this->logContents());
    }

    public function testAnAbandonedLeaseIsRecoveredWithoutForgivingItsAttempt(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'lease.key.value', $this->clock->now());

        // A runner claims, then dies: the row keeps the lease it left behind.
        $claimed = $this->jobs->claimDue($this->owner('dead'), 10, ['email']);
        self::assertCount(1, $claimed);

        // One second before expiry, the job is still its owner's.
        $this->clock->advanceSeconds($this->policy->leaseSeconds - 1);
        self::assertSame(0, $this->jobs->recoverAbandonedLeases());
        self::assertSame([], $this->jobs->claimDue($this->owner('other'), 10, ['email']));

        // One second after, it is recoverable.
        $this->clock->advanceSeconds(2);
        self::assertSame(1, $this->jobs->recoverAbandonedLeases());

        $job = $this->jobs->findByIdempotencyKey('lease.key.value');
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame('pending', $job->status);
        self::assertNull($job->leaseOwner);
        self::assertSame('lease_expired', $job->lastErrorCode);
        self::assertSame(1, $job->attempts, 'recovery must not forgive the attempt it already charged');

        self::assertCount(1, $this->jobs->claimDue($this->owner('other'), 10, ['email']));
    }

    public function testAJobThatKillsEveryRunnerExhaustsItsBudgetInsteadOfLoopingForever(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'zombie.key.value', $this->clock->now());

        for ($cycle = 1; $cycle <= $this->policy->maxAttempts; ++$cycle) {
            $claimed = $this->jobs->claimDue($this->owner("cycle{$cycle}"), 10, ['email']);
            self::assertCount(1, $claimed, "cycle {$cycle} did not claim");
            $this->clock->advanceSeconds($this->policy->leaseSeconds + 1);
            $this->jobs->recoverAbandonedLeases();
        }

        // The budget is spent. `claimDue` refuses to charge a sixth attempt, which
        // is also what `chk_notification_jobs_attempts` would refuse.
        self::assertSame([], $this->jobs->claimDue($this->owner('final'), 10, ['email']));

        $job = $this->jobs->findByIdempotencyKey('zombie.key.value');
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame($this->policy->maxAttempts, $job->attempts);
    }

    public function testARunnerWhoseLeaseExpiredCannotRecordADeliveryItNoLongerOwns(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'slow.key.value', $this->clock->now());

        $slow = $this->jobs->claimDue($this->owner('slow'), 10, ['email']);
        self::assertCount(1, $slow);
        $slowOwner = $slow[0]->leaseOwner;
        self::assertIsString($slowOwner);

        // While the slow transport is working, the lease expires and a second
        // runner takes the job.
        $this->clock->advanceSeconds($this->policy->leaseSeconds + 1);
        $this->jobs->recoverAbandonedLeases();
        $fast = $this->jobs->claimDue($this->owner('fast'), 10, ['email']);
        self::assertCount(1, $fast);

        // The slow runner finally returns. Its write is a no-op, not a race.
        self::assertFalse($this->jobs->markSent($slow[0], $slowOwner));

        $fastOwner = $fast[0]->leaseOwner;
        self::assertIsString($fastOwner);
        self::assertTrue($this->jobs->markSent($fast[0], $fastOwner));

        $job = $this->jobs->findByIdempotencyKey('slow.key.value');
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame('sent', $job->status);
        self::assertSame(1, $this->rowCount("SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'sent'"));
    }

    public function testOneRunClaimsAtMostItsBatchSoARecoveredBacklogIsDrainedNotBurst(): void
    {
        $bookingId = $this->seedBooking();

        for ($i = 1; $i <= 12; ++$i) {
            $this->jobs->enqueue(
                $bookingId,
                'email',
                'booking_confirmation',
                \sprintf('burst.key.%03d', $i),
                $this->clock->now(),
            );
        }

        $transport = new RecordingTransport('email');

        $first = $this->runner($transport)->run($this->owner('one'), 5);
        self::assertSame(5, $first->claimed);
        self::assertSame(5, $first->sent);

        $second = $this->runner($transport)->run($this->owner('one'), 5);
        self::assertSame(5, $second->claimed);

        $third = $this->runner($transport)->run($this->owner('one'), 5);
        self::assertSame(2, $third->claimed);

        self::assertSame(12, $transport->delivered);
        self::assertSame(0, $this->runner($transport)->run($this->owner('one'), 5)->claimed);
    }

    public function testARunIsRefusedOutrightWhenAnEnabledChannelHasNoTransport(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'sms', 'booking_confirmation', 'notransport.key.x', $this->clock->now());
        $this->channels->set(['email', 'sms']);

        try {
            $this->runner(new RecordingTransport('email'))->run($this->owner('one'), 10);
            self::fail('the run started with an undeliverable channel enabled');
        } catch (NotificationException $exception) {
            self::assertStringContainsString('no transport is registered', $exception->getMessage());
        }

        // Nothing was claimed, so nothing was charged an attempt.
        $job = $this->jobs->findByIdempotencyKey('notransport.key.x');
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame('pending', $job->status);
        self::assertSame(0, $job->attempts);
    }

    // --- ESZ-072: catch-up --------------------------------------------------

    public function testAStaleReminderIsRetiredBeforeItCanBeClaimedAndIsNeverDelivered(): void
    {
        $bookingId = $this->seedBooking();
        $due = $this->clock->now();
        $this->jobs->enqueue($bookingId, 'email', 'booking_reminder', 'stale.key.value', $due);

        // Cron was down for a day. The first tick after it comes back retires the
        // reminder rather than delivering it.
        $this->clock->advanceMinutes(24 * 60);

        $transport = new RecordingTransport('email');
        $result = $this->runner($transport)->run($this->owner('one'), 10);

        self::assertSame(1, $result->staleSkipped);
        self::assertSame(0, $result->claimed);
        self::assertSame(0, $transport->delivered);

        $job = $this->jobs->findByIdempotencyKey('stale.key.value');
        self::assertInstanceOf(NotificationJob::class, $job);
        self::assertSame('skipped', $job->status);
        self::assertSame('reminder_window_expired', $job->lastErrorCode);
        self::assertNull($job->sentAtUtc);

        // Terminal: no later tick resurrects it.
        self::assertSame(0, $this->runner($transport)->run($this->owner('two'), 10)->staleSkipped);
        self::assertSame(0, $transport->delivered);
    }

    public function testAReminderStillInsideItsGraceWindowIsDeliveredNormally(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_reminder', 'fresh.key.value', $this->clock->now());

        $this->clock->advanceMinutes($this->policy->reminderGraceMinutes - 1);

        $transport = new RecordingTransport('email');
        $result = $this->runner($transport)->run($this->owner('one'), 10);

        self::assertSame(1, $result->sent);
        self::assertSame(1, $transport->delivered);
    }

    public function testAReminderThatCrossesItsWindowWhileQueuedIsSkippedAfterBeingClaimed(): void
    {
        // The sweep alone is not enough: a batch claimed at the start of a tick
        // can still be waiting behind a slow transport when the window closes.
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_reminder', 'crossing.key.val', $this->clock->now());

        $clock = $this->clock;
        $grace = $this->policy->reminderGraceMinutes;

        $transport = new RecordingTransport('email');
        $transport->before = static function () use ($clock, $grace): void {
            $clock->advanceMinutes($grace + 1);
        };

        // The first job in the batch pushes the clock past the window; a second
        // reminder behind it must not be delivered late.
        $this->jobs->enqueue($bookingId, 'email', 'booking_reminder', 'behind.key.value', $this->clock->now());

        $result = $this->runner($transport)->run($this->owner('one'), 10);

        self::assertSame(2, $result->claimed);
        self::assertSame(1, $result->sent);
        self::assertSame(1, $result->skipped);
        self::assertSame(1, $transport->delivered);

        $late = $this->jobs->findByIdempotencyKey('behind.key.value');
        self::assertInstanceOf(NotificationJob::class, $late);
        self::assertSame('skipped', $late->status);
        self::assertSame('reminder_window_expired', $late->lastErrorCode);
    }

    public function testANonTimeSensitiveJobIsNeverRetiredForBeingOld(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'oldconfirm.key.x', $this->clock->now());

        $this->clock->advanceMinutes(90 * 24 * 60);

        $transport = new RecordingTransport('email');
        $result = $this->runner($transport)->run($this->owner('one'), 10);

        self::assertSame(0, $result->staleSkipped);
        self::assertSame(1, $result->sent);
    }

    public function testADisabledChannelProducesTerminalSkipsSoAReEnableHasNoBacklog(): void
    {
        $bookingId = $this->seedBooking();
        $settings = new NotificationChannelSettings($this->database, $this->clock, $this->policy);

        // The default with no row at all: email on, SMS off. A restored database
        // that lost its settings must not start sending SMS.
        self::assertSame(['email'], $settings->enabledChannels());
        self::assertFalse($settings->isEnabled('sms'));

        $scheduler = new NotificationScheduler(
            $this->jobs,
            new NotificationCatchUpPolicy($settings, $this->policy, $this->clock),
        );

        $decisions = [];
        for ($day = 1; $day <= 6; ++$day) {
            $decisions[] = $scheduler->schedule(
                $bookingId,
                self::REFERENCE,
                'sms',
                'booking_reminder',
                $this->clock->now()->modify("+{$day} days"),
            );
        }

        foreach ($decisions as $decision) {
            self::assertSame('skipped', $decision['status']);
            self::assertSame('channel_disabled', $decision['errorCode']);
        }

        // A week passes and SMS is switched back on.
        $this->clock->advanceMinutes(7 * 24 * 60);
        $settings->setEnabled('sms', true);
        self::assertSame(['email', 'sms'], $settings->enabledChannels());

        // There is nothing pending to flush: every window that passed while SMS
        // was off was decided at the time and is terminal.
        self::assertSame(
            0,
            $this->rowCount("SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'pending'"),
        );
        self::assertSame(6, $this->rowCount("SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'skipped'"));

        $transport = new RecordingTransport('email');
        $registry = new NotificationTransportRegistry($this->policy, [$transport, new RecordingTransport('sms')]);
        $runner = new NotificationRunner($this->jobs, $registry, $settings, $this->policy, $this->logger);

        $result = $runner->run($this->owner('one'), $this->policy->maxBatchSize);
        self::assertSame(0, $result->claimed, 're-enabling SMS produced a burst');

        // And the next appointment scheduled after the re-enable is ordinary.
        $decision = $scheduler->schedule(
            $bookingId,
            self::REFERENCE,
            'sms',
            'booking_reminder',
            $this->clock->now()->modify('+2 days'),
        );
        self::assertSame('pending', $decision['status']);
    }

    public function testSchedulingAHistoricalReminderRecordsASkipRatherThanQueueingABackfill(): void
    {
        $bookingId = $this->seedBooking();
        $scheduler = new NotificationScheduler(
            $this->jobs,
            new NotificationCatchUpPolicy($this->channels, $this->policy, $this->clock),
        );

        // The shape of an accidental backfill: a script walking historical
        // bookings and creating the reminders they never got.
        for ($day = 1; $day <= 10; ++$day) {
            $decision = $scheduler->schedule(
                $bookingId,
                self::REFERENCE,
                'email',
                'booking_reminder',
                $this->clock->now()->modify("-{$day} days"),
            );

            self::assertSame('skipped', $decision['status'], "day -{$day}");
            self::assertSame('reminder_window_expired', $decision['errorCode']);
        }

        self::assertSame(
            0,
            $this->rowCount("SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'pending'"),
        );

        $transport = new RecordingTransport('email');
        self::assertSame(0, $this->runner($transport)->run($this->owner('one'), 50)->claimed);
        self::assertSame(0, $transport->delivered);
    }

    // --- ESZ-071: logging ---------------------------------------------------

    public function testNoCustomerFactAppearsInAnyNotificationLogLine(): void
    {
        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'logged.key.sent', $this->clock->now());
        $this->jobs->enqueue(
            $bookingId,
            'email',
            'booking_reminder',
            'logged.key.stale',
            $this->clock->now()->modify('-1 day'),
        );
        $this->jobs->enqueue($bookingId, 'sms', 'booking_confirmation', 'logged.key.retry', $this->clock->now());

        $this->channels->set(['email', 'sms']);

        $registry = new NotificationTransportRegistry($this->policy, [
            new LoggingNotificationTransport('email', $this->logger, $this->policy),
            new FailingTransport('sms', new TransientDeliveryException('transport_transient')),
        ]);

        $runner = new NotificationRunner($this->jobs, $registry, $this->channels, $this->policy, $this->logger);
        $runner->run($this->owner('one'), 10);

        $log = $this->logContents();
        self::assertNotSame('', $log, 'the runner logged nothing at all');

        foreach (
            [
                'Cliente Exemple',
                'cliente@example.test',
                '+33612345678',
                'Je suis allergique',
                'eszter-test',
            ] as $secret
        ) {
            self::assertStringNotContainsString($secret, $log, $secret);
        }

        // Every key on every line is on the allowlist.
        foreach (explode("\n", trim($log)) as $line) {
            if ($line === '') {
                continue;
            }
            /** @var array<string, mixed> $decoded */
            $decoded = json_decode($line, true);
            foreach (array_keys($decoded) as $key) {
                self::assertTrue(
                    \in_array($key, ['ts', 'level', 'message'], true)
                        || $this->policy->isLogFieldAllowed((string) $key),
                    "log line carried `{$key}`",
                );
            }
        }

        // And the opaque reference *is* there, so the ban is on customer data
        // rather than on anything useful.
        self::assertStringContainsString(self::REFERENCE, $log);
    }

    // --- ESZ-071: two independent processes ---------------------------------

    /**
     * The proof that matters: two operating-system processes, two connections,
     * one due job.
     *
     * Everything above runs on one connection, where MySQL has no opportunity to
     * interleave anything. This test commits the fixture, holds the row from a
     * third connection so both workers block on the same `UPDATE`, releases, and
     * asserts that exactly one of them delivered.
     */
    public function testTwoIndependentRunnerProcessesCannotDeliverOneJobTwice(): void
    {
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);

        $bookingId = $this->seedBooking();
        $this->jobs->enqueue($bookingId, 'email', 'booking_confirmation', 'concurrent.key.one', $this->clock->now());

        // Hold the row so both workers reach the claim and wait on the same lock.
        $this->database->beginTransaction();
        $held = $this->database->fetchOne(
            'SELECT id FROM notification_jobs WHERE idempotency_key = :key FOR UPDATE',
            ['key' => 'concurrent.key.one'],
        );
        self::assertNotNull($held);

        $workers = [];
        foreach ([0, 1] as $index) {
            $ready = $this->root . "/notify-worker-{$index}.ready";
            $pipes = [];
            $process = proc_open(
                [PHP_BINARY, __DIR__ . '/NotificationRunnerWorker.php', $ready],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes,
            );
            self::assertIsResource($process);
            fclose($pipes[0]);
            $workers[] = ['process' => $process, 'pipes' => $pipes, 'ready' => $ready];
        }

        $deadline = microtime(true) + 10.0;
        do {
            $ready = array_filter($workers, static fn (array $worker): bool => is_file($worker['ready']));
            if (\count($ready) === 2) {
                break;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);
        self::assertCount(2, $ready, 'both workers did not reach the claim');

        // Give them time to actually block on the UPDATE rather than merely
        // having started. Without this the test could pass by serialising them.
        usleep(300_000);
        $this->database->rollBack();

        $outcomes = [];
        foreach ($workers as $worker) {
            $stdout = trim((string) stream_get_contents($worker['pipes'][1]));
            $stderr = trim((string) stream_get_contents($worker['pipes'][2]));
            fclose($worker['pipes'][1]);
            fclose($worker['pipes'][2]);
            self::assertSame(0, proc_close($worker['process']), $stderr);
            $outcomes[] = $stdout;
        }
        sort($outcomes);

        // Exactly one delivered. The other found nothing to claim.
        self::assertSame(['CLAIMED 0 SENT 0', 'CLAIMED 1 SENT 1'], $outcomes);

        $row = $this->database->fetchOne(
            'SELECT status, attempts FROM notification_jobs WHERE idempotency_key = :key',
            ['key' => 'concurrent.key.one'],
        );
        self::assertSame('sent', $row['status'] ?? null);
        self::assertSame(1, $row['attempts'] ?? null, 'the job was attempted more than once');
        self::assertSame(1, $this->rowCount('SELECT COUNT(*) AS n FROM notification_jobs'));

        TestDatabase::truncateData($this->database);
        $this->database->beginTransaction();
    }

    // --- helpers ------------------------------------------------------------

    private function seedBooking(string $reference = self::REFERENCE): int
    {
        $this->database->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at)'
            . " VALUES ('lips', 'Lèvres', 60, 0, 0, 1, :created, :updated)"
            . ' ON DUPLICATE KEY UPDATE booking_label = VALUES(booking_label)',
            ['created' => self::NOW, 'updated' => self::NOW],
        );

        $this->database->run(
            'INSERT INTO bookings'
            . ' (reference, service_key, state, starts_at_utc, ends_at_utc, timezone_name,'
            . ' customer_name, customer_email, customer_phone, customer_note, consent_at_utc,'
            . ' created_at, updated_at, state_changed_at)'
            . ' VALUES (:reference, :service, :state, :starts, :ends, :zone,'
            . ' :name, :email, :phone, :note, :consent, :created, :updated, :changed)',
            [
                'reference' => $reference,
                'service' => 'lips',
                'state' => 'confirmed',
                'starts' => '2026-06-15 10:00:00.000',
                'ends' => '2026-06-15 11:00:00.000',
                'zone' => 'Europe/Paris',
                'name' => 'Cliente Exemple',
                'email' => 'cliente@example.test',
                'phone' => '+33612345678',
                'note' => 'Je suis allergique au latex',
                'consent' => '2026-06-13 09:00:00.000',
                'created' => self::NOW,
                'updated' => self::NOW,
                'changed' => self::NOW,
            ],
        );

        return (int) $this->database->pdo()->lastInsertId();
    }

    private function runner(NotificationTransport $transport): NotificationRunner
    {
        return new NotificationRunner(
            $this->jobs,
            new NotificationTransportRegistry($this->policy, [$transport]),
            $this->channels,
            $this->policy,
            $this->logger,
        );
    }

    private function owner(string $tag): string
    {
        return NotificationRunner::ownerFor('test-' . $tag, getmypid() ?: 1);
    }

    private function databaseTime(\DateTimeImmutable $instant): string
    {
        return $instant->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.v');
    }

    private function secondsBetween(\DateTimeImmutable $from, string $databaseTime): int
    {
        $to = \DateTimeImmutable::createFromFormat(
            'Y-m-d H:i:s.v',
            $databaseTime,
            new \DateTimeZone('UTC'),
        );
        self::assertNotFalse($to);

        return $to->getTimestamp() - $from->getTimestamp();
    }

    private function rowCount(string $sql): int
    {
        $row = $this->database->fetchOne($sql);

        return (int) ($row['n'] ?? 0);
    }

    private function logContents(): string
    {
        return is_file($this->logPath) ? (string) file_get_contents($this->logPath) : '';
    }
}
