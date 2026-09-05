<?php

declare(strict_types=1);

namespace Eszter\Tests\Notification;

use Eszter\Notification\NotificationCatchUpPolicy;
use Eszter\Notification\NotificationJob;
use Eszter\Notification\NotificationLogContext;
use Eszter\Notification\NotificationPolicy;
use Eszter\Notification\NotificationRunner;
use Eszter\Tests\MovableClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The catch-up decision and the log allowlist, asserted without a database
 * (ESZ-071/072).
 *
 * Both are pure functions of the frozen policy and the clock, and both are the
 * kind of rule that is easy to state and easy to quietly break. Keeping them out
 * of the SQL gate means they are checked on every `php:unit` run rather than only
 * where MySQL happens to be available.
 */
final class NotificationCatchUpTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private NotificationPolicy $policy;
    private MovableClock $clock;
    private FixedEnabledChannels $channels;

    protected function setUp(): void
    {
        $this->policy = NotificationPolicy::fromArtifacts(TestEnvironment::artifacts());
        $this->clock = new MovableClock(self::NOW);
        $this->channels = new FixedEnabledChannels(['email']);
    }

    public function testAReminderInsideTheGraceWindowIsScheduledAndOutsideItIsSkipped(): void
    {
        $scheduler = $this->scheduler();
        $grace = $this->policy->reminderGraceMinutes;

        // Due right now: obviously deliverable.
        self::assertSame(
            ['status' => 'pending', 'errorCode' => null],
            $scheduler->decide('email', 'booking_reminder', $this->at(0)),
        );

        // One minute inside the window: still deliverable. This is the boundary
        // the policy actually promises, so it is asserted rather than assumed.
        self::assertSame(
            ['status' => 'pending', 'errorCode' => null],
            $scheduler->decide('email', 'booking_reminder', $this->at(-($grace - 1) * 60)),
        );

        // One minute outside it: never sent, and recorded as such.
        self::assertSame(
            ['status' => 'skipped', 'errorCode' => 'reminder_window_expired'],
            $scheduler->decide('email', 'booking_reminder', $this->at(-($grace + 1) * 60)),
        );
    }

    public function testOnlyTimeSensitiveTypesExpireAtAll(): void
    {
        $scheduler = $this->scheduler();
        $longPast = $this->at(-90 * 24 * 3600);

        // A confirmation from three months ago is still worth sending: the
        // customer needs to know the appointment exists, whenever they find out.
        foreach (['booking_confirmation', 'booking_cancellation', 'booking_moved'] as $type) {
            self::assertSame(
                ['status' => 'pending', 'errorCode' => null],
                $scheduler->decide('email', $type, $longPast),
                $type,
            );
        }

        self::assertSame(
            ['status' => 'skipped', 'errorCode' => 'reminder_window_expired'],
            $scheduler->decide('email', 'booking_reminder', $longPast),
        );
    }

    /**
     * The anti-backfill guarantee, stated as the sequence that would break it.
     *
     * SMS is off; a season of appointments comes and goes; SMS is switched back
     * on. Every decision made while it was off was `skipped`, and switching it
     * back on changes only what happens next — there is no backlog, so there is
     * nothing to burst.
     */
    public function testReEnablingAChannelNeitherBackfillsNorBursts(): void
    {
        $scheduler = $this->scheduler();
        $this->channels->set(['email']);

        $whileOff = [];
        foreach (range(1, 20) as $day) {
            $whileOff[] = $scheduler->decide('sms', 'booking_reminder', $this->at($day * 86_400));
        }

        foreach ($whileOff as $index => $decision) {
            self::assertSame('skipped', $decision['status'], "decision {$index}");
            self::assertSame('channel_disabled', $decision['errorCode']);
        }

        // Two months pass, then SMS comes back.
        $this->clock->advanceMinutes(60 * 24 * 60);
        $this->channels->set(['email', 'sms']);

        // A future appointment is scheduled normally…
        self::assertSame(
            ['status' => 'pending', 'errorCode' => null],
            $scheduler->decide('sms', 'booking_reminder', $this->at(86_400)),
        );

        // …and every window that closed while the channel was off stays closed.
        // This is the assertion that matters: re-enabling cannot resurrect them,
        // because the grace window is a fact about the appointment, not about the
        // channel's history.
        foreach (range(1, 20) as $day) {
            self::assertSame(
                ['status' => 'skipped', 'errorCode' => 'reminder_window_expired'],
                $scheduler->decide('sms', 'booking_reminder', $this->at(-$day * 86_400)),
            );
        }
    }

    public function testADisabledChannelIsReportedAsDisabledEvenWhenTheWindowAlsoClosed(): void
    {
        $scheduler = $this->scheduler();
        $this->channels->set([]);

        // Order matters: the operator turning SMS back on needs to see that the
        // channel was off, not that a window they never controlled had closed.
        self::assertSame(
            ['status' => 'skipped', 'errorCode' => 'channel_disabled'],
            $scheduler->decide('sms', 'booking_reminder', $this->at(-86_400)),
        );
    }

    public function testTheIdempotencyKeyIsStableForOneIntentAndDistinctForAnother(): void
    {
        $scheduler = $this->scheduler();
        $reference = 'bk_' . str_repeat('a', 32);
        $due = $this->at(86_400);

        $first = $scheduler->idempotencyKey($reference, 'email', 'booking_reminder', $due);
        $second = $scheduler->idempotencyKey($reference, 'email', 'booking_reminder', $due);
        self::assertSame($first, $second, 'the same intent must produce the same key');
        self::assertTrue($this->policy->acceptsIdempotencyKey($first));

        // A different channel, type or occurrence is a different notification.
        self::assertNotSame($first, $scheduler->idempotencyKey($reference, 'sms', 'booking_reminder', $due));
        self::assertNotSame(
            $first,
            $scheduler->idempotencyKey($reference, 'email', 'booking_confirmation', $due),
        );
        self::assertNotSame(
            $first,
            $scheduler->idempotencyKey($reference, 'email', 'booking_reminder', $this->at(2 * 86_400)),
        );

        // A confirmation is not recurring, so moving the booking does not make a
        // second one: there is only ever one confirmation per booking per channel.
        self::assertSame(
            $scheduler->idempotencyKey($reference, 'email', 'booking_confirmation', $due),
            $scheduler->idempotencyKey($reference, 'email', 'booking_confirmation', $this->at(9 * 86_400)),
        );
        self::assertNotSame(
            $scheduler->idempotencyKey($reference, 'email', 'booking_moved', $due),
            $scheduler->idempotencyKey($reference, 'email', 'booking_moved', $this->at(9 * 86_400)),
            'distinct moves must not collapse into one lifecycle e-mail',
        );
    }

    public function testTheLogContextDropsEverythingThatIsNotOnTheAllowlist(): void
    {
        $job = new NotificationJob(
            17,
            'bk_' . str_repeat('a', 32) . '.email.booking_reminder',
            42,
            'bk_' . str_repeat('a', 32),
            null,
            'email',
            'booking_reminder',
            '2026-06-14 08:00:00.000',
            '2026-06-14 08:00:00.000',
            'processing',
            2,
            null,
            null,
            'host.1.abcdef123456',
            '2026-06-14 08:02:00.000',
        );

        $context = NotificationLogContext::forJob($job, $this->policy, [
            'status' => 'sent',
            'durationMs' => 12,
            // Everything below is what a careless caller would add, and none of
            // it may survive.
            'customerEmail' => 'cliente@example.test',
            'customerPhone' => '+33612345678',
            'customerName' => 'Cliente Exemple',
            'customerNote' => 'Je suis allergique au…',
            'body' => 'Bonjour, votre rendez-vous…',
            'apiKey' => 'sk-live-abcdef',
        ]);

        self::assertSame(
            [
                'jobId', 'bookingReference', 'channel', 'jobType', 'status',
                'attempts', 'dueAtUtc', 'leaseOwner', 'durationMs',
            ],
            array_keys($context),
        );

        $encoded = json_encode($context);
        self::assertIsString($encoded);
        foreach (['cliente@example.test', '+33612345678', 'Cliente', 'allergique', 'Bonjour', 'sk-live'] as $leak) {
            self::assertStringNotContainsString($leak, $encoded, $leak);
        }
    }

    public function testAnAllowedKeyStillCannotCarryAnArbitraryString(): void
    {
        // The subtler leak: not a forbidden key, but a forbidden *value* riding in
        // on an allowed one. `errorCode` is narrowed to the frozen code pattern.
        $context = NotificationLogContext::filter($this->policy, [
            'errorCode' => 'smtp 550 no mailbox for cliente@example.test',
            'jobId' => 5,
        ]);

        self::assertSame(['errorCode' => 'unclassified', 'jobId' => 5], $context);
    }

    public function testTwoRunnersOnOneHostInOneSecondCannotShareALeaseOwner(): void
    {
        $owners = [];
        for ($i = 0; $i < 200; ++$i) {
            $owners[] = NotificationRunner::ownerFor('web-01.example.test', 4242);
        }

        self::assertCount(200, array_unique($owners));

        foreach ($owners as $owner) {
            self::assertTrue($this->policy->acceptsLeaseOwner($owner), $owner);
        }

        // A hostile hostname cannot break the owner pattern the schema enforces.
        self::assertTrue(
            $this->policy->acceptsLeaseOwner(NotificationRunner::ownerFor("../../etc/passwd\n", 1)),
        );
        self::assertTrue($this->policy->acceptsLeaseOwner(NotificationRunner::ownerFor('', 0)));
    }

    /** No database, and none needed: the catch-up rules are pure policy. */
    private function scheduler(): NotificationCatchUpPolicy
    {
        return new NotificationCatchUpPolicy($this->channels, $this->policy, $this->clock);
    }

    private function at(int $offsetSeconds): \DateTimeImmutable
    {
        return $this->clock->now()->modify(\sprintf('%+d seconds', $offsetSeconds));
    }
}
