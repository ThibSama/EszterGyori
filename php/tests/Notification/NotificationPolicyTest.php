<?php

declare(strict_types=1);

namespace Eszter\Tests\Notification;

use Eszter\Notification\NotificationPolicy;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * Package 7.1 policy, read from the generated artifact and checked against the
 * schema that has to agree with it (ESZ-070/071/072).
 *
 * No database. Everything here is decidable from the frozen contract plus the
 * migration file, and keeping it out of the SQL gates means a contributor
 * without MySQL still finds out that they changed a frozen enum.
 */
final class NotificationPolicyTest extends TestCase
{
    private NotificationPolicy $policy;

    protected function setUp(): void
    {
        $this->policy = NotificationPolicy::fromArtifacts(TestEnvironment::artifacts());
    }

    public function testTheFrozenEnumsAreExactlyWhatThePackageDeclares(): void
    {
        self::assertSame(['email', 'sms'], $this->policy->channels);
        self::assertSame(
            ['booking_confirmation', 'booking_reminder', 'booking_cancellation', 'booking_moved'],
            $this->policy->jobTypes,
        );
        self::assertSame(['booking_reminder'], $this->policy->timeSensitiveJobTypes);
        self::assertSame(
            ['pending', 'processing', 'sent', 'failed', 'skipped'],
            $this->policy->statuses,
        );
        self::assertSame('pending', $this->policy->initialStatus);
        self::assertSame(['sent', 'failed', 'skipped'], $this->policy->terminalStatuses);
    }

    public function testTheStatusGraphHasThreeTerminalStatesAndNoWayBackOut(): void
    {
        self::assertSame(['processing', 'skipped'], $this->policy->nextStatuses('pending'));
        self::assertSame(
            ['sent', 'pending', 'failed', 'skipped'],
            $this->policy->nextStatuses('processing'),
        );

        foreach ($this->policy->terminalStatuses as $terminal) {
            self::assertSame([], $this->policy->nextStatuses($terminal), $terminal);
            self::assertTrue($this->policy->isTerminal($terminal));

            foreach ($this->policy->statuses as $target) {
                self::assertFalse(
                    $this->policy->allowsTransition($terminal, $target),
                    "{$terminal} -> {$target} must be impossible",
                );
            }
        }

        // A claimed job can only be claimed from pending, so nothing can steal a
        // job that is already being delivered.
        self::assertTrue($this->policy->allowsTransition('pending', 'processing'));
        self::assertFalse($this->policy->allowsTransition('processing', 'processing'));
        self::assertFalse($this->policy->allowsTransition('sent', 'pending'));
    }

    public function testBackoffIsDeterministicBoundedAndGrowsFromTheFirstRetry(): void
    {
        // The first retry — after one attempt — waits the base delay, not twice it.
        self::assertSame(60, $this->policy->backoffSeconds(1));
        self::assertSame(120, $this->policy->backoffSeconds(2));
        self::assertSame(240, $this->policy->backoffSeconds(3));
        self::assertSame(480, $this->policy->backoffSeconds(4));

        // Clamped, and clamped without ever computing an absurd intermediate.
        self::assertSame(3600, $this->policy->backoffSeconds(40));
        self::assertSame(3600, $this->policy->backoffSeconds(PHP_INT_MAX));

        // Deterministic: no jitter, so the same input is the same delay.
        self::assertSame(
            $this->policy->backoffSeconds(3),
            $this->policy->backoffSeconds(3),
        );

        self::assertFalse($this->policy->attemptsExhausted(4));
        self::assertTrue($this->policy->attemptsExhausted(5));
        self::assertTrue($this->policy->attemptsExhausted(6));
    }

    public function testTheErrorCodePatternCannotExpressCustomerData(): void
    {
        foreach (['transport_transient', 'lease_expired', 'reminder_window_expired'] as $code) {
            self::assertTrue($this->policy->acceptsErrorCode($code), $code);
        }

        // The point of the pattern: none of these is expressible as a code, so
        // the stored diagnostic cannot become a place customer data leaks to.
        foreach (
            [
                'cliente@example.test',
                'smtp 550 no mailbox',
                '+33 6 12 34 56 78',
                'Bonjour, je voudrais…',
                'Bearer sk-live-abcdef',
                'UPPER_CASE',
                'x',
                '',
            ] as $notACode
        ) {
            self::assertFalse($this->policy->acceptsErrorCode($notACode), $notACode);
        }

        foreach ($this->policy->reservedErrorCodes as $reserved) {
            self::assertTrue($this->policy->acceptsErrorCode($reserved), $reserved);
        }
    }

    public function testTheLogAllowlistExcludesEveryFieldDeclaredForbidden(): void
    {
        foreach ($this->policy->forbiddenLogFields as $forbidden) {
            self::assertFalse(
                $this->policy->isLogFieldAllowed($forbidden),
                "{$forbidden} is both allowed and forbidden",
            );
        }

        // The allowlist names the opaque booking reference and no customer field.
        self::assertTrue($this->policy->isLogFieldAllowed('bookingReference'));
        self::assertFalse($this->policy->isLogFieldAllowed('customerEmail'));
        self::assertFalse($this->policy->isLogFieldAllowed('body'));

        // And a field nobody thought about is refused by default rather than
        // passed through, which is the difference between an allowlist and a
        // redaction filter.
        self::assertFalse($this->policy->isLogFieldAllowed('providerResponse'));
    }

    /**
     * The migration restates the frozen sets where SQL can enforce them. This is
     * the test that stops the restatement from drifting: it reads the actual
     * `.sql` file and looks for each frozen value inside the CHECK constraints.
     */
    public function testTheMigrationRestatesTheFrozenSetsAndBounds(): void
    {
        $sql = file_get_contents(
            TestEnvironment::repositoryRoot() . '/php/migrations/0009_notification_jobs.sql',
        );
        self::assertIsString($sql);

        foreach ([...$this->policy->channels, ...$this->policy->jobTypes, ...$this->policy->statuses] as $value) {
            self::assertStringContainsString("'{$value}'", $sql, "{$value} is not in the migration");
        }

        self::assertStringContainsString($this->policy->idempotencyKeyPattern, $sql);
        self::assertStringContainsString($this->policy->errorCodePattern, $sql);
        self::assertStringContainsString($this->policy->leaseOwnerPattern, $sql);

        // The attempt ceiling is written into the schema, so a runner bug cannot
        // produce a row claiming a sixth attempt.
        self::assertStringContainsString(
            "attempts BETWEEN 0 AND {$this->policy->maxAttempts}",
            $sql,
        );

        // ON DELETE RESTRICT, never CASCADE: notification history must not
        // disappear with the booking it describes.
        self::assertStringContainsString('ON DELETE RESTRICT', $sql);
        self::assertStringNotContainsString('ON DELETE CASCADE', $sql);
    }

    public function testIdentityAndLeasePatternsAcceptTheShapesTheRunnerProduces(): void
    {
        self::assertTrue(
            $this->policy->acceptsIdempotencyKey('bk_' . str_repeat('a', 32) . '.email.booking_confirmation'),
        );
        self::assertFalse($this->policy->acceptsIdempotencyKey('short'));
        self::assertFalse($this->policy->acceptsIdempotencyKey('Has.Upper.Case'));
        self::assertFalse($this->policy->acceptsIdempotencyKey(str_repeat('a', 129)));

        self::assertTrue($this->policy->acceptsLeaseOwner('host.1234.abcdef123456'));
        self::assertFalse($this->policy->acceptsLeaseOwner('short'));
        self::assertFalse($this->policy->acceptsLeaseOwner('has space here'));
    }
}
