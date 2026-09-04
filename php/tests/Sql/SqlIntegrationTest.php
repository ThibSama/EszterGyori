<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Admin\AdminAccountRepository;
use Eszter\Admin\AdminEmail;
use Eszter\Auth\PdoSessionStore;
use Eszter\Auth\Session;
use Eszter\Booking\BookableServiceNotFoundException;
use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\AvailabilityRepository;
use Eszter\Booking\AvailabilityRevisionConflictException;
use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\Booking;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingRepository;
use Eszter\Booking\BookingRevisionConflictException;
use Eszter\Booking\BookingSerializationLock;
use Eszter\Booking\BookingStateMachine;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\PdoBookingApi;
use Eszter\Booking\SlotUnavailableException;
use Eszter\Booking\InvalidBookingTransitionException;
use Eszter\Booking\SlotEngine;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Config\SessionSettings;
use Eszter\Database\Database;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Notification\NotificationPolicy;
use Eszter\Notification\BookingNotificationFactsRepository;
use Eszter\Notification\BookingNotificationProducer;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\PermanentDeliveryException;
use Eszter\Retention\BookingRetentionService;
use Eszter\Retention\RetentionPolicy;
use Eszter\Security\RateLimitPolicy;
use Eszter\Support\Clock;
use Eszter\Support\FrozenClock;
use Eszter\Support\IsoTimestamp;
use Eszter\Tests\MovableClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/**
 * The `sql:integration` gate (ESZ-023 / ESZ-024 / ESZ-025).
 *
 * "Admin, booking, settings and notification repositories against a real MySQL
 * instance seeded from migrations, each test isolated in a rolled-back
 * transaction." — `docs/v1-quality-gates.md`. Package 4.1 adds booking service
 * and appointment-state persistence; settings remains schema-only and
 * notifications do not exist yet.
 *
 * The schema is built by running the real migrations once, so this gate also
 * proves that what `sql:migrations` produces is what the repositories were
 * written against — a schema hand-built for the tests would let the two drift.
 *
 * ## Isolation
 *
 * Each test runs inside a transaction that is rolled back in `tearDown()`. Every
 * repository shares one connection, so they all see the same uncommitted state
 * and none of it survives the test. `TRUNCATE` is not used per test because it
 * commits implicitly on MySQL and would defeat the rollback.
 *
 * The last group of tests drives the real front controller against this database,
 * which is the only place in the suite where authentication, CSRF and MySQL are
 * exercised together. `php:http-contract` proves the same surface against
 * in-memory doubles; this proves the doubles were not lying.
 */
#[Group('sql')]
final class SqlIntegrationTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const EMAIL = 'editor@example.test';
    private const PASSWORD = 'correct-horse-battery';

    /** ESZ-140 fixtures: the customer values retention must erase and never print. */
    private const OLD_NAME = 'Ancienne Cliente';
    private const OLD_EMAIL = 'ancienne@example.test';
    private const OLD_PHONE = '+33 6 11 22 33 44';
    private const OLD_NOTE = 'note sensible';

    /** ESZ-101 fixtures: the neighbour account and the rotated credential. */
    private const SECOND_EMAIL = 'second-editor@example.test';
    private const SECOND_PASSWORD = 'second-correct-horse';
    private const ROTATED_PASSWORD = 'rotated-esz101-password';

    /**
     * The frozen clock the ESZ-134 production-wiring kernels boot with, and the
     * value their recordLogin writes. Distinct from the suite's 2026 clock, so
     * an injected-failure trigger can never misfire on another test's rows.
     */
    private const FAILED_LOGIN_NOW = '2099-06-13T12:00:00.000Z';

    /**
     * The frozen clock of the ESZ-134 rehash kernels. Distinct from
     * {@see FAILED_LOGIN_NOW} so the two injected-failure triggers cannot
     * interfere even if one were ever left behind.
     */
    private const REHASH_NOW = '2098-06-13T12:00:00.000Z';

    /** ESZ-130 fixtures: the abusing client address (documentation range). */
    private const ESZ130_ADDRESS = '203.0.113.130';

    private static bool $migrated = false;

    private Database $database;
    private FrozenClock $clock;
    private AdminAccountRepository $accounts;
    private PdoSessionStore $sessions;
    private BookableServiceRepository $bookingServices;
    private BookingRepository $bookings;
    private AvailabilityRepository $availability;
    private SlotEngine $slots;
    private BookingDomainContract $bookingContract;
    private BookingTimePolicy $bookingTime;
    private PdoBookingApi $bookingApi;
    private string $root;

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

        $this->clock = new FrozenClock(self::NOW);
        $this->accounts = new AdminAccountRepository($this->database, $this->clock);
        $this->sessions = new PdoSessionStore($this->database, $this->clock);
        $this->bookingContract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
        $this->bookingTime = new BookingTimePolicy($this->bookingContract);
        $this->bookingServices = new BookableServiceRepository(
            $this->database,
            $this->clock,
            $this->bookingContract,
            new BookingSerializationLock($this->database),
        );
        $this->bookings = new BookingRepository(
            $this->database,
            $this->clock,
            $this->bookingContract,
            $this->bookingTime,
            $this->bookingServices,
            new BookingStateMachine($this->bookingContract),
        );
        $this->availability = new AvailabilityRepository(
            $this->database,
            $this->clock,
            $this->bookingContract,
            $this->bookingTime,
            new BookingSerializationLock($this->database),
        );
        $this->slots = new SlotEngine($this->bookingContract, $this->bookingTime);
        $this->bookingApi = PdoBookingApi::createDefault(
            $this->database,
            $this->clock,
            $this->bookingContract,
            NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
        );
        $this->root = TestEnvironment::makeTempDirectory('eszter-sql');

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

    // --- ESZ-024: admin identity -------------------------------------------

    public function testProvisioningCreatesAnAccountAndIsSafeToRepeat(): void
    {
        $email = $this->email(self::EMAIL);

        $first = $this->accounts->provision($email, self::PASSWORD, true);

        self::assertTrue($first['created']);
        self::assertSame(self::EMAIL, $first['account']->email);
        self::assertTrue($first['account']->isEnabled);

        // The realistic second run: the operator is not sure the first one worked.
        // It must update the same row, not fail on the unique index and not create
        // a second account.
        $second = $this->accounts->provision($email, self::PASSWORD, true);

        self::assertFalse($second['created']);
        self::assertSame($first['account']->id, $second['account']->id);
        self::assertCount(1, $this->accounts->all());
    }

    public function testTheStoredPasswordIsAHashAndVerifiesAgainstThePlaintext(): void
    {
        $account = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];

        // The column holds a hash, and specifically not the password.
        self::assertNotSame(self::PASSWORD, $account->passwordHash);
        self::assertStringNotContainsString(self::PASSWORD, $account->passwordHash);
        self::assertTrue(password_verify(self::PASSWORD, $account->passwordHash));
        self::assertFalse(password_verify('wrong', $account->passwordHash));

        // A modern algorithm, not a legacy one that merely happens to work.
        $info = password_get_info($account->passwordHash);
        self::assertContains($info['algoName'], ['argon2id', 'argon2i', 'bcrypt']);
        self::assertFalse(AdminAccountRepository::needsRehash($account->passwordHash));

        // And nothing about the account serialises the hash by accident.
        self::assertStringNotContainsString(
            $account->passwordHash,
            (string) json_encode($account) . print_r($account, true),
        );
    }

    public function testTwoSpellingsOfOneAddressAreOneAccount(): void
    {
        $this->accounts->provision($this->email('Editor@Example.TEST'), self::PASSWORD, true);
        $result = $this->accounts->provision($this->email('  editor@example.test  '), 'another-password', true);

        // Normalisation is what makes the unique index mean "one person". Without
        // it these are two rows and one of them is unreachable while looking,
        // from outside, exactly like a wrong password.
        self::assertFalse($result['created']);
        self::assertCount(1, $this->accounts->all());
        self::assertSame('editor@example.test', $result['account']->email);
    }

    public function testAnAccentDifferenceIsTwoDifferentAccounts(): void
    {
        // The reason `email` is utf8mb4_bin rather than the table's accent- and
        // case-insensitive default: under `utf8mb4_unicode_ci` these two collide
        // on the unique index and the second insert fails.
        $this->accounts->provision($this->email('rene@example.test'), self::PASSWORD, true);
        $this->accounts->provision($this->email('renée@example.test'), self::PASSWORD, true);

        self::assertCount(2, $this->accounts->all());
    }

    public function testProvisioningCanDisableWithoutKnowingThePassword(): void
    {
        $created = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];

        $result = $this->accounts->provision($this->email(self::EMAIL), null, false);

        self::assertFalse($result['account']->isEnabled);
        self::assertFalse($result['passwordChanged']);
        // The hash is untouched, so re-enabling restores the same credential.
        self::assertSame($created->passwordHash, $result['account']->passwordHash);
    }

    public function testANewAccountWithoutAPasswordIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        $this->accounts->provision($this->email(self::EMAIL), null, true);
    }

    public function testAMalformedAddressIsRefusedAtProvisioningTime(): void
    {
        // Provisioning validates, because the operator is the one being helped.
        // Login deliberately does not — see `auth.loginFailure`.
        $this->expectException(\InvalidArgumentException::class);

        $this->email('not-an-address');
    }

    public function testRecordingALoginUpdatesOnlyTheTimestamp(): void
    {
        $account = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];
        self::assertNull($account->lastLoginAt);

        $this->accounts->recordLogin($account->id, '2026-07-01T09:00:00.000Z');

        $reloaded = $this->accounts->findById($account->id);
        self::assertNotNull($reloaded);
        self::assertSame('2026-07-01T09:00:00.000Z', $reloaded->lastLoginAt);
        self::assertSame($account->passwordHash, $reloaded->passwordHash);
        self::assertSame($account->isEnabled, $reloaded->isEnabled);
    }

    // --- ESZ-025: sessions --------------------------------------------------

    public function testASessionRoundTripsThroughMysql(): void
    {
        $session = $this->session(null, '+1 hour', '+12 hours');
        $this->sessions->save($session);

        $found = $this->sessions->find($session->id);

        self::assertNotNull($found);
        self::assertSame($session->id, $found->id);
        self::assertSame($session->csrfToken, $found->csrfToken);
        self::assertNull($found->accountId);
        self::assertFalse($found->isAuthenticated());
    }

    public function testAnIdleExpiredSessionIsNotFound(): void
    {
        $this->sessions->save($expired = $this->session(null, '-1 second', '+12 hours'));

        // Expiry is decided in the query, not by a caller who might forget.
        self::assertNull($this->sessions->find($expired->id));
    }

    public function testASessionPastItsAbsoluteCeilingIsNotFound(): void
    {
        // Idle deadline in the future, absolute deadline in the past: the shape a
        // continuously-used — that is, stolen — session ends up in.
        $this->sessions->save($session = $this->session(null, '+1 hour', '-1 second'));

        self::assertNull($this->sessions->find($session->id));
    }

    public function testUsingASessionExtendsIdleButNeverTheAbsoluteCeiling(): void
    {
        $this->sessions->save($session = $this->session(null, '+10 minutes', '+30 minutes'));

        // What SessionManager::touch() writes: a new idle deadline, and an
        // absolute one it tries — and must fail — to push out.
        $this->sessions->save(new Session(
            $session->id,
            $session->accountId,
            $session->csrfToken,
            $session->createdAt,
            self::NOW,
            $this->at('+1 hour'),
            $this->at('+99 hours'),
        ));

        $found = $this->sessions->find($session->id);

        self::assertNotNull($found);
        self::assertSame($this->at('+1 hour'), $found->expiresAt);
        self::assertSame(
            $this->at('+30 minutes'),
            $found->absoluteExpiresAt,
            'the absolute ceiling was extended by using the session',
        );
    }

    public function testDestroyingASessionRemovesTheRow(): void
    {
        $this->sessions->save($session = $this->session(null, '+1 hour', '+12 hours'));

        $this->sessions->destroy($session->id);

        self::assertNull($this->sessions->find($session->id));
        self::assertSame([], $this->database->fetchAll('SELECT id FROM admin_sessions'));
    }

    public function testDisablingAnAccountCanSignItOutEverywhere(): void
    {
        $account = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];
        $other = $this->accounts->provision($this->email('other@example.test'), self::PASSWORD, true)['account'];

        $this->sessions->save($this->session($account->id, '+1 hour', '+12 hours'));
        $this->sessions->save($this->session($account->id, '+1 hour', '+12 hours'));
        $this->sessions->save($mine = $this->session($other->id, '+1 hour', '+12 hours'));

        self::assertSame(2, $this->sessions->destroyForAccount($account->id));

        // Someone else's sessions are untouched.
        self::assertNotNull($this->sessions->find($mine->id));
    }

    public function testGarbageCollectionRemovesOnlyExpiredSessions(): void
    {
        $this->sessions->save($live = $this->session(null, '+1 hour', '+12 hours'));
        $this->sessions->save($this->session(null, '-1 second', '+12 hours'));
        $this->sessions->save($this->session(null, '+1 hour', '-1 second'));

        self::assertSame(2, $this->sessions->collectGarbage());
        self::assertNotNull($this->sessions->find($live->id));
    }

    public function testAMalformedSessionIdNeverReachesTheDatabase(): void
    {
        // Not a correctness fix — a malformed id cannot match a row anyway — but a
        // hygiene one: attacker-chosen bytes never enter a query or a query log.
        foreach (["' OR 1=1 --", str_repeat('z', 64), '', 'ABCDEF'] as $id) {
            self::assertNull($this->sessions->find($id));
        }
    }

    // --- ESZ-041 / ESZ-042: booking foundation ----------------------------

    public function testBookableServiceProvisioningIsExplicitRepeatSafeAndOperationalOnly(): void
    {
        self::assertSame([], $this->bookingServices->all());

        $first = $this->bookingServices->provision('brows', 'Sourcils', 120, 15, 20, true);
        $second = $this->bookingServices->provision('brows', 'Sourcils premium', 135, 10, 25, true);

        self::assertTrue($first['created']);
        self::assertFalse($second['created']);
        self::assertSame('brows', $second['service']->key);
        self::assertSame('Sourcils premium', $second['service']->label);
        self::assertSame(135, $second['service']->durationMinutes);
        self::assertSame(10, $second['service']->bufferBeforeMinutes);
        self::assertSame(25, $second['service']->bufferAfterMinutes);
        self::assertCount(1, $this->bookingServices->all());

        $row = $this->database->fetchOne('SELECT * FROM booking_services WHERE service_key = :key', [
            'key' => 'brows',
        ]);
        self::assertIsArray($row);
        self::assertArrayNotHasKey('description', $row);
        self::assertArrayNotHasKey('media', $row);
    }

    public function testServiceValidationUsesTheCanonicalKeysAndTypedFailures(): void
    {
        foreach (
            [
                ['not-in-content', 'Unknown', 60, 0, 0],
                ['brows', '', 60, 0, 0],
                ['brows', 'Brows', 4, 0, 0],
                ['brows', 'Brows', 60, -1, 0],
                ['brows', 'Brows', 60, 0, 241],
            ] as [$key, $label, $duration, $before, $after]
        ) {
            try {
                $this->bookingServices->provision($key, $label, $duration, $before, $after, true);
                self::fail("Invalid service {$key}/{$label} was persisted.");
            } catch (BookingValidationException $exception) {
                self::assertNotSame('', $exception->field);
            }
        }

        self::assertSame([], $this->bookingServices->all());
    }

    public function testBookingPersistsUtcFactsAndReferencesTheCanonicalService(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 120, 15, 15, true);

        $booking = $this->bookings->createConfirmed(
            'brows',
            new \DateTimeImmutable('2026-07-01T08:00:00.000Z'),
            new \DateTimeImmutable('2026-07-01T10:00:00.000Z'),
            'Cliente Exemple',
            'cliente@example.test',
            '+336****0000',
            'Test only',
            new \DateTimeImmutable('2026-06-13T12:00:00.000Z'),
            $this->bookingContract->currentConsentNoticeId,
        );

        self::assertSame('confirmed', $booking->state->value);
        self::assertSame('Europe/Paris', $booking->timezoneName);
        self::assertSame('2026-07-01 08:00:00.000', $booking->startsAtUtc);
        self::assertSame('2026-07-01 10:00:00.000', $booking->endsAtUtc);
        self::assertNull($booking->cancelledAtUtc);
        self::assertMatchesRegularExpression('/^bk_[0-9a-f]{32}$/', $booking->reference);
    }

    public function testBookingRequiresAProvisionedActiveService(): void
    {
        try {
            $this->createBookingFor('brows');
            self::fail('booking against an unprovisioned service was accepted');
        } catch (BookableServiceNotFoundException $exception) {
            self::assertSame('brows', $exception->serviceKey);
        }

        $this->bookingServices->provision('brows', 'Sourcils', 120, 0, 0, false);
        $this->expectException(BookingValidationException::class);
        $this->createBookingFor('brows');
    }

    public function testBookingIntervalMustMatchTheProvisionedServiceDuration(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 90, 0, 0, true);

        $this->expectException(BookingValidationException::class);
        $this->expectExceptionMessage('provisioned service duration');
        $this->createBookingFor('brows');
    }

    public function testCancellationChangesStateAndNeverDeletesTheBooking(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 120, 0, 0, true);
        $booking = $this->createBookingFor('brows');

        $cancelled = $this->bookings->transition($booking->reference, 'cancelled', 'Cliente indisponible');

        self::assertSame($booking->id, $cancelled->id);
        self::assertSame('cancelled', $cancelled->state->value);
        // ESZ-139: the cancellation instant is the derived mutation instant —
        // strictly later than the row's updatedAt (equal frozen clock ⇒ +1 ms).
        self::assertSame('2026-06-13 12:00:00.001', $cancelled->cancelledAtUtc);
        self::assertSame('Cliente indisponible', $cancelled->cancellationReason);
        self::assertSame(1, (int) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n'] ?? 0));
    }

    public function testCancelledIsTerminalAndARepeatedCancellationFailsExplicitly(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 120, 0, 0, true);
        $booking = $this->createBookingFor('brows');
        $this->bookings->transition($booking->reference, 'cancelled');

        $this->expectException(InvalidBookingTransitionException::class);
        $this->bookings->transition($booking->reference, 'cancelled');
    }

    // --- ESZ-043 / ESZ-044 / ESZ-045: dynamic availability ----------------

    public function testWeeklyRulesPersistMultipleWindowsOptionalBoundsAndRejectOverlaps(): void
    {
        $rules = [
            $this->weeklyRule(1, '14:00', '17:00', '2026-06-01', null),
            $this->weeklyRule(1, '09:00', '12:00'),
            $this->weeklyRule(3, '10:00', '13:00', null, '2026-12-31'),
        ];
        $this->availability->replaceWeeklyRules($this->availabilityHead(), $rules);

        $stored = $this->availability->weeklyRules();
        self::assertCount(3, $stored);
        self::assertSame([1, 1, 3], array_column($stored, 'weekdayIso'));
        self::assertNull($stored[0]->validFrom);
        self::assertNull($stored[1]->validUntil);

        try {
            $this->availability->replaceWeeklyRules($this->availabilityHead(), [
                $this->weeklyRule(1, '09:00', '12:00'),
                $this->weeklyRule(1, '11:45', '13:00'),
            ]);
            self::fail('Overlapping weekly rules were stored.');
        } catch (BookingValidationException $exception) {
            self::assertSame('weeklyRules', $exception->field);
        }
        self::assertCount(3, $this->availability->weeklyRules(), 'failed replace changed stored rules');

        $this->availability->replaceWeeklyRules($this->availabilityHead(), [
            $this->weeklyRule(1, '09:00', '10:00', null, '2026-06-30'),
            $this->weeklyRule(1, '09:00', '10:00', '2026-07-01', null),
            $this->weeklyRule(1, '10:00', '11:00'),
        ]);
        self::assertCount(3, $this->availability->weeklyRules());
    }

    public function testOneDateExceptionStoresOrderedReplacementWindowsAndCanBecomeClosed(): void
    {
        try {
            $this->availability->putOpenException($this->availabilityHead(), '2026-07-14', [
                $this->availabilityWindow('09:00', '12:00'),
                $this->availabilityWindow('11:00', '14:00'),
            ]);
            self::fail('Overlapping exception windows were stored.');
        } catch (BookingValidationException $exception) {
            self::assertSame('windows', $exception->field);
        }
        self::assertNull($this->availability->findException('2026-07-14'));

        $open = $this->availability->putOpenException($this->availabilityHead(), '2026-07-14', [
            $this->availabilityWindow('14:00', '17:00'),
            $this->availabilityWindow('09:00', '12:00'),
        ], 'Lunch closure');

        self::assertSame('open', $open->kind);
        self::assertSame(['09:00:00', '14:00:00'], array_column($open->windows, 'startLocal'));
        self::assertSame(1, (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM availability_exceptions',
        )['n'] ?? 0));
        self::assertSame(1, (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM availability_exception_windows',
        )['n'] ?? 0));

        $closed = $this->availability->putClosedException($this->availabilityHead(), '2026-07-14', 'Public holiday');
        self::assertSame('closed', $closed->kind);
        self::assertSame([], $closed->windows);
        self::assertSame(0, (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM availability_exception_windows',
        )['n'] ?? 0));
        self::assertCount(1, $this->availability->exceptionsBetween('2026-07-01', '2026-07-31'));
    }

    public function testDateExceptionsValidateSpringGapAndAutumnFoldAtWriteTime(): void
    {
        try {
            $this->availability->putOpenException(
                $this->availabilityHead(),
                '2026-03-29',
                [$this->availabilityWindow('02:15', '03:30')],
            );
            self::fail('A spring-gap boundary was stored.');
        } catch (BookingValidationException) {
            self::addToAssertionCount(1);
        }

        try {
            $this->availability->putOpenException(
                $this->availabilityHead(),
                '2026-10-25',
                [$this->availabilityWindow('02:00', '03:00')],
            );
            self::fail('An ambiguous fold boundary was stored without an offset.');
        } catch (BookingValidationException) {
            self::addToAssertionCount(1);
        }

        $stored = $this->availability->putOpenException(
            $this->availabilityHead(),
            '2026-10-25',
            [$this->availabilityWindow('02:00', '03:00', '+01:00')],
        );
        self::assertSame('+01:00', $stored->windows[0]->foldUtcOffset);
    }

    public function testMysqlOccupancyExpandsBuffersAndCancellationStopsBlocking(): void
    {
        $service = $this->bookingServices->provision('brows', 'Sourcils', 30, 15, 15, true)['service'];
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $booking = $this->bookings->createConfirmed(
            'brows',
            new \DateTimeImmutable('2026-07-06T08:00:00Z'),
            new \DateTimeImmutable('2026-07-06T08:30:00Z'),
            'Cliente Exemple',
            'cliente@example.test',
            null,
            null,
            new \DateTimeImmutable(self::NOW),
            $this->bookingContract->currentConsentNoticeId,
        );

        $rangeStart = new \DateTimeImmutable('2026-07-05T22:00:00Z');
        $rangeEnd = new \DateTimeImmutable('2026-07-06T22:00:00Z');
        $occupied = $this->bookings->occupiedBetween($rangeStart, $rangeEnd);
        self::assertCount(1, $occupied);
        self::assertSame('2026-07-06 07:45:00', $occupied[0]->startsAtUtc->format('Y-m-d H:i:s'));
        self::assertSame('2026-07-06 08:45:00', $occupied[0]->endsAtUtc->format('Y-m-d H:i:s'));

        $starts = array_column($this->slots->generate(
            $service,
            '2026-07-06',
            '2026-07-06',
            $this->availability->weeklyRules(),
            [],
            $occupied,
        ), 'localStart');
        self::assertSame(['11:00', '11:15'], $starts);

        $this->bookings->transition($booking->reference, 'cancelled');
        self::assertSame([], $this->bookings->occupiedBetween($rangeStart, $rangeEnd));
        self::assertCount(9, $this->slots->generate(
            $service,
            '2026-07-06',
            '2026-07-06',
            $this->availability->weeklyRules(),
            [],
            [],
        ));
    }

    public function testStoredOpenExceptionReplacesWeeklySlotsEndToEnd(): void
    {
        $service = $this->bookingServices->provision('brows', 'Sourcils', 30, 15, 15, true)['service'];
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $this->availability->putOpenException(
            $this->availabilityHead(),
            '2026-07-06',
            [$this->availabilityWindow('14:00', '15:00')],
        );

        $slots = $this->slots->generate(
            $service,
            '2026-07-06',
            '2026-07-06',
            $this->availability->weeklyRules(),
            $this->availability->exceptionsBetween('2026-07-06', '2026-07-06'),
            [],
        );

        self::assertSame(['14:15'], array_column($slots, 'localStart'));
    }

    // --- ESZ-046 / ESZ-047 / ESZ-048: booking API application layer -------

    public function testPublicServiceDiscoveryReturnsOnlyActiveBookingFacts(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils réservation', 30, 15, 15, true);
        $this->bookingServices->provision('lips', 'Lèvres réservation', 45, 0, 0, false);

        self::assertSame([
            'services' => [[
                'key' => 'brows',
                'label' => 'Sourcils réservation',
                'durationMinutes' => 30,
            ]],
        ], $this->bookingApi->services());
    }

    public function testPublicAvailabilityUsesTheEngineAndPersistsNoSlots(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 15, 15, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);

        $response = $this->bookingApi->availability([
            'serviceKey' => 'brows',
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ]);

        self::assertSame('Europe/Paris', $response['timezone']);
        self::assertSame(
            ['09:15', '09:30', '09:45', '10:00', '10:15'],
            array_column($response['slots'], 'localStart'),
        );
        self::assertSame([], $this->database->fetchAll("SHOW TABLES LIKE '%slot%'"));

        $this->expectException(BookingValidationException::class);
        $this->bookingApi->availability([
            'serviceKey' => 'brows',
            'fromDate' => '2026-06-12',
            'untilDate' => '2026-06-15',
        ]);
    }

    public function testPublicAvailabilityRejectsImpossibleDatesAndCarriesExplicitFallFold(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);

        try {
            $this->bookingApi->availability([
                'serviceKey' => 'brows',
                'fromDate' => '2026-02-30',
                'untilDate' => '2026-02-30',
            ]);
            self::fail('An impossible civil date was accepted.');
        } catch (BookingValidationException) {
            self::addToAssertionCount(1);
        }

        $fallClock = new FrozenClock('2026-10-24T10:00:00.000Z');
        $fallApi = PdoBookingApi::createDefault(
            $this->database,
            $fallClock,
            $this->bookingContract,
            NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
        );
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [
            $this->weeklyRule(7, '02:00', '03:00', null, null, '+01:00'),
        ]);

        $response = $fallApi->availability([
            'serviceKey' => 'brows',
            'fromDate' => '2026-10-25',
            'untilDate' => '2026-10-25',
        ]);

        self::assertSame(['02:00', '02:15', '02:30'], array_column($response['slots'], 'localStart'));
        self::assertSame(['+01:00', '+01:00', '+01:00'], array_column($response['slots'], 'foldUtcOffset'));
        self::assertSame('2026-10-25T01:00:00.000Z', $response['slots'][0]['startsAtUtc']);
    }

    public function testAtomicPublicCreationStoresConsentAndCreatedHistory(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);

        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $stored = $this->bookings->find((string) $created['reference']);

        self::assertNotNull($stored);
        self::assertSame('confirmed', $created['state']);
        self::assertSame('2026-06-13 12:00:00.000', $stored->consentAtUtc);
        self::assertSame('Cliente Exemple', $stored->customerName);
        // ESZ-142: the notice id the request carried is stored beside the
        // consent instant — the durable mapping to the accepted wording.
        self::assertSame(
            $this->bookingContract->currentConsentNoticeId,
            $stored->consentNoticeId,
        );
        $row = $this->database->fetchOne(
            'SELECT consent_notice_id, consent_at_utc FROM bookings WHERE id = :booking',
            ['booking' => $stored->id],
        );
        self::assertSame($this->bookingContract->currentConsentNoticeId, $row['consent_notice_id']);
        self::assertSame('2026-06-13 12:00:00.000', $row['consent_at_utc']);
        $history = $this->database->fetchAll(
            'SELECT event_type, actor_type FROM booking_history WHERE booking_id = :booking',
            ['booking' => $stored->id],
        );
        self::assertSame([['event_type' => 'created', 'actor_type' => 'public']], $history);
        self::assertArrayNotHasKey('customerEmail', $created);
    }

    /**
     * ESZ-142 — a missing notice id is refused by the booking domain before
     * the transaction opens: nothing is inserted, no history row and no
     * notification job can survive a refusal.
     */
    public function testCreatingWithoutANoticeIdIsRefusedBeforeInsertion(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);

        $request = $this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z');
        unset($request['consentNoticeId']);

        try {
            $this->bookingApi->create($request);
            self::fail('a booking without a consent notice id was accepted.');
        } catch (BookingValidationException $exception) {
            self::assertSame('consentNoticeId', $exception->field);
        }

        self::assertSame(0, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n']);
        self::assertSame(0, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM booking_history')['n']);
    }

    /**
     * ESZ-142 — an id the immutable catalog does not contain is refused by
     * the booking domain before the transaction opens; the server never
     * guesses which notice the client meant.
     */
    public function testCreatingWithAnUnknownNoticeIdIsRefusedBeforeInsertion(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);

        $request = $this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z');
        $request['consentNoticeId'] = 'booking-consent-9999';

        try {
            $this->bookingApi->create($request);
            self::fail('an unknown consent notice id was accepted.');
        } catch (BookingValidationException $exception) {
            self::assertSame('consentNoticeId', $exception->field);
        }

        self::assertSame(0, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n']);
        self::assertSame(0, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM booking_history')['n']);
    }

    /**
     * ESZ-142 — an id that is well-formed ASCII but names no catalog entry
     * (bypassing the structural enum, exactly as a direct domain caller can)
     * is refused the same way.
     */
    public function testCreatingWithAWireTextPayloadIsRefusedBecauseNoFieldAcceptsText(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);

        $request = $this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z');
        // A client can never make the server store what the visitor did NOT
        // read: the only accepted value is an id from the catalog. Any extra
        // "notice text" field is ignored by the strict schema at the HTTP
        // layer and refused here by the required id check.
        unset($request['consentNoticeId']);
        $request['consentNoticeText'] = "J'accepte que mes coordonnées soient utilisées.";

        try {
            $this->bookingApi->create($request);
            self::fail('a request with notice text but no notice id was accepted.');
        } catch (BookingValidationException $exception) {
            self::assertSame('consentNoticeId', $exception->field);
        }

        self::assertSame(0, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n']);
    }

    /**
     * ESZ-142 — the stored notice id is immutable evidence: an admin contact
     * update (the only mutation that touches customer fields) never rewrites
     * consent_at_utc or consent_notice_id.
     */
    public function testAdminContactUpdatesNeverRewriteTheStoredConsentFacts(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);

        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $booking = $this->bookings->find((string) $created['reference']);
        self::assertNotNull($booking);

        $this->adminMutateFresh('update', $booking->reference, [
            'customerName' => 'Cliente Modifiée',
            'customerEmail' => 'modifiee@example.test',
        ]);

        $row = $this->database->fetchOne(
            'SELECT customer_name, consent_at_utc, consent_notice_id FROM bookings WHERE id = :booking',
            ['booking' => $booking->id],
        );
        self::assertSame('Cliente Modifiée', $row['customer_name']);
        self::assertSame('2026-06-13 12:00:00.000', $row['consent_at_utc']);
        self::assertSame($this->bookingContract->currentConsentNoticeId, $row['consent_notice_id']);
    }

    public function testBookingLifecycleProducesStableAtomicEmailJobsAndSupersedesReminders(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);

        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $booking = $this->bookings->find((string) $created['reference']);
        self::assertNotNull($booking);

        $initial = $this->notificationRows($booking->id);
        self::assertSame(['booking_confirmation', 'booking_reminder'], array_column($initial, 'job_type'));
        self::assertSame(['pending', 'pending'], array_column($initial, 'status'));
        self::assertSame('2026-06-13 12:00:00.000', $initial[0]['due_at_utc']);
        self::assertSame('2026-06-14 07:00:00.000', $initial[1]['due_at_utc']);

        try {
            $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
            self::fail('an API retry unexpectedly created the occupied slot twice');
        } catch (SlotUnavailableException) {
            self::assertCount(2, $this->notificationRows($booking->id));
        }

        $this->adminMutateFresh('move', $booking->reference, ['startsAtUtc' => '2026-06-15T08:00:00.000Z']);
        $moved = $this->notificationRows($booking->id);
        self::assertSame(
            ['booking_confirmation', 'booking_reminder', 'booking_moved', 'booking_reminder'],
            array_column($moved, 'job_type'),
        );
        self::assertSame('skipped', $moved[1]['status']);
        self::assertSame('reminder_superseded', $moved[1]['last_error_code']);
        self::assertSame('2026-06-14 08:00:00.000', $moved[3]['due_at_utc']);

        $this->adminMutateFresh('cancel', $booking->reference, ['reason' => null]);
        $cancelled = $this->notificationRows($booking->id);
        self::assertSame('skipped', $cancelled[3]['status']);
        self::assertSame('booking_cancelled', $cancelled[3]['last_error_code']);
        self::assertSame('booking_cancellation', $cancelled[4]['job_type']);
        self::assertSame('pending', $cancelled[4]['status']);
        self::assertCount(5, $cancelled);
        self::assertCount(3, $this->database->fetchAll(
            'SELECT id FROM booking_history WHERE booking_id = :booking',
            ['booking' => $booking->id],
        ));
    }

    public function testMovingNeverRewritesAPreviouslySentReminder(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $booking = $this->bookings->find((string) $created['reference']);
        self::assertNotNull($booking);
        $this->database->run(
            'UPDATE notification_jobs SET status = :sent, sent_at_utc = :sentAt'
            . ' WHERE booking_id = :booking AND job_type = :type',
            [
                'sent' => 'sent',
                'sentAt' => '2026-06-13 12:01:00.000',
                'booking' => $booking->id,
                'type' => 'booking_reminder',
            ],
        );

        $this->adminMutateFresh('move', $booking->reference, ['startsAtUtc' => '2026-06-15T08:00:00.000Z']);
        $rows = $this->notificationRows($booking->id);

        self::assertSame('sent', $rows[1]['status']);
        self::assertNull($rows[1]['last_error_code']);
        self::assertSame('booking_reminder', $rows[3]['job_type']);
        self::assertSame('pending', $rows[3]['status']);
    }

    public function testReminderAlreadyOutsideCatchUpIsRecordedAsTerminalSkip(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(7, '09:00', '10:00')]);

        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-14T07:00:00.000Z'));
        $booking = $this->bookings->find((string) $created['reference']);
        self::assertNotNull($booking);
        $rows = $this->notificationRows($booking->id);

        self::assertSame('booking_reminder', $rows[1]['job_type']);
        self::assertSame('skipped', $rows[1]['status']);
        self::assertSame('reminder_window_expired', $rows[1]['last_error_code']);
    }

    public function testProducerFailureRollsBackBookingHistoryAndNotificationTogether(): void
    {
        // Leave the suite's rollback-only wrapper so the booking API owns the
        // outermost transaction, exactly as it does in production. Fixtures
        // below commit independently; the forced producer failure must undo
        // only the attempted lifecycle mutation.
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '10:00')]);
        $policy = NotificationPolicy::fromArtifacts(TestEnvironment::artifacts());
        $jobs = new NotificationJobRepository($this->database, $this->clock, $policy);
        $producer = new class ($jobs, $this->clock) implements BookingNotificationProducer {
            public function __construct(
                private readonly NotificationJobRepository $jobs,
                private readonly FrozenClock $clock,
            ) {
            }

            public function created(Booking $booking): void
            {
                $this->jobs->enqueue(
                    $booking->id,
                    'email',
                    'booking_confirmation',
                    $booking->reference . '.email.booking_confirmation',
                    $this->clock->now(),
                );
                throw new \RuntimeException('forced producer failure');
            }

            public function moved(Booking $before, Booking $after): void
            {
            }

            public function cancelled(Booking $booking): void
            {
            }
        };
        $api = PdoBookingApi::createDefault(
            $this->database,
            $this->clock,
            $this->bookingContract,
            $policy,
            $producer,
        );

        try {
            $api->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
            self::fail('producer failure did not abort booking creation');
        } catch (\RuntimeException $exception) {
            self::assertSame('forced producer failure', $exception->getMessage());
        }

        self::assertSame(0, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n']);
        self::assertSame(0, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM booking_history')['n']);
        self::assertSame(0, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM notification_jobs')['n']);
    }

    public function testStaleSlotAcrossServicesAndBuffersCannotCreateTwice(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 15, 15, true);
        $this->bookingServices->provision('lips', 'Lèvres', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);
        $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:15:00.000Z'));

        $this->expectException(SlotUnavailableException::class);
        $this->bookingApi->create($this->publicBookingRequest('lips', '2026-06-15T07:30:00.000Z'));
    }

    public function testAdminUpdateMoveCancelAndReadAppendHistoryWithoutReplacingTheRow(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $reference = (string) $created['reference'];
        $id = $this->bookings->find($reference)?->id;

        $this->adminMutateFresh('update', $reference, [
            'customerName' => 'Cliente Corrigée',
            'customerEmail' => 'corrigee@example.test',
            'customerPhone' => null,
            'customerNote' => 'Corrigé',
        ]);
        $this->adminMutateFresh('move', $reference, ['startsAtUtc' => '2026-06-15T08:00:00.000Z']);
        $cancelled = $this->adminMutateFresh('cancel', $reference, ['reason' => 'Cliente indisponible']);
        $queried = $this->bookingApi->adminQuery(['mode' => 'reference', 'reference' => $reference]);

        self::assertSame($id, $this->bookings->find($reference)?->id);
        self::assertSame('cancelled', $cancelled['booking']['state']);
        self::assertSame('Cliente Corrigée', $queried['bookings'][0]['customerName']);
        self::assertSame('2026-06-15T08:00:00.000Z', $queried['bookings'][0]['startsAtUtc']);
        self::assertSame(
            ['created', 'customer_updated', 'moved', 'cancelled'],
            array_column($queried['bookings'][0]['history'], 'type'),
        );
        $availableAfterCancellation = $this->bookingApi->availability([
            'serviceKey' => 'brows',
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ]);
        self::assertContains('10:00', array_column($availableAfterCancellation['slots'], 'localStart'));

        $this->expectException(InvalidBookingTransitionException::class);
        $this->adminMutateFresh('move', $reference, ['startsAtUtc' => '2026-06-15T09:00:00.000Z']);
    }

    public function testContactUpdateOnCancelledBooking(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $reference = (string) $created['reference'];

        $this->adminMutateFresh('cancel', $reference, ['reason' => 'Cliente indisponible']);
        $updated = $this->adminMutateFresh('update', $reference, [
            'customerName' => 'Nouvelle Représentante',
            'customerEmail' => 'representante@example.test',
            'customerPhone' => null,
            'customerNote' => null,
        ]);

        self::assertSame('cancelled', $updated['booking']['state']);
        self::assertSame('Nouvelle Représentante', $updated['booking']['customerName']);
        self::assertSame('representante@example.test', $updated['booking']['customerEmail']);
        self::assertSame(
            ['created', 'cancelled', 'customer_updated'],
            array_column($updated['booking']['history'], 'type'),
        );
    }

    public function testAdminMoveRevalidatesAgainstAnotherServiceAndLeavesSourceUntouched(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 15, 15, true);
        $this->bookingServices->provision('lips', 'Lèvres', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $source = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:15:00.000Z'));
        $this->bookingApi->create($this->publicBookingRequest('lips', '2026-06-15T09:00:00.000Z'));

        try {
            $this->adminMutateFresh('move', (string) $source['reference'], [
                'startsAtUtc' => '2026-06-15T09:00:00.000Z',
            ]);
            self::fail('A move onto an occupied cross-service interval committed.');
        } catch (SlotUnavailableException) {
            self::addToAssertionCount(1);
        }

        $stored = $this->bookings->find((string) $source['reference']);
        self::assertSame('2026-06-15 07:15:00.000', $stored?->startsAtUtc);
        self::assertSame(
            ['created'],
            array_column($this->bookingApi->adminQuery([
                'mode' => 'reference',
                'reference' => $source['reference'],
            ])['bookings'][0]['history'], 'type'),
        );
    }

    public function testAdminMoveAvailabilityExcludesOnlyTheBookingBeingMoved(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 15, 15, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $source = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:15:00.000Z'));

        $public = $this->bookingApi->availability([
            'serviceKey' => 'brows',
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ]);
        $move = $this->bookingApi->adminMoveAvailability([
            'reference' => $source['reference'],
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ]);

        self::assertNotContains('09:15', array_column($public['slots'], 'localStart'));
        self::assertContains('09:15', array_column($move['slots'], 'localStart'));
        self::assertSame('brows', $move['serviceKey']);
        self::assertSame('Europe/Paris', $move['timezone']);
    }

    public function testBookingHttpRoutesKeepPublicErrorsOpaqueAndGuardAdminMutations(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();

        $serviceList = $kernel->handle(new Request('GET', '/api/booking/services'));
        self::assertSame(200, $serviceList->status);
        self::assertSame('brows', $serviceList->decodedBody()['services'][0]['key'] ?? null);
        self::assertStringNotContainsString('buffer', $serviceList->body);

        $availability = $kernel->handle(new Request(
            'POST',
            '/api/booking/availability',
            ['content-type' => 'application/json'],
            (string) json_encode([
                'serviceKey' => 'brows',
                'fromDate' => '2026-06-15',
                'untilDate' => '2026-06-15',
            ]),
        ));
        self::assertSame(200, $availability->status);

        $request = $this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z');
        $created = $kernel->handle(new Request(
            'POST',
            '/api/bookings',
            ['content-type' => 'application/json'],
            (string) json_encode($request),
        ));
        self::assertSame(201, $created->status);
        $reference = (string) ($created->decodedBody()['reference'] ?? '');

        $stale = $kernel->handle(new Request(
            'POST',
            '/api/bookings',
            ['content-type' => 'application/json'],
            (string) json_encode($request),
        ));
        self::assertSame(409, $stale->status);
        self::assertSame('SLOT_UNAVAILABLE', $stale->decodedBody()['error']['code'] ?? null);
        self::assertStringNotContainsString('cliente@example.test', $stale->body);
        self::assertStringNotContainsString('booking_resource_locks', $stale->body);

        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $accepted = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );
        /** @var array<string, mixed> $loginBody */
        $loginBody = $accepted->decodedBody();
        $sessionId = self::cookieValue($accepted);
        $csrf = (string) $loginBody['csrfToken'];

        $query = $kernel->handle(new Request(
            'POST',
            '/api/admin/bookings/query',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                'content-type' => 'application/json',
            ],
            (string) json_encode(['mode' => 'reference', 'reference' => $reference]),
        ));
        self::assertSame(200, $query->status);

        $mutation = [
            'action' => 'update',
            'reference' => $reference,
            // ESZ-139: the PATCH carries the booking's own token, read from
            // the authenticated query just above.
            'expectedUpdatedAt' => (string) ($query->decodedBody()['bookings'][0]['updatedAt'] ?? ''),
            'customerName' => 'Cliente HTTP',
            'customerEmail' => 'cliente@example.test',
            'customerPhone' => null,
            'customerNote' => null,
        ];
        $withoutCsrf = $kernel->handle(new Request(
            'PATCH',
            '/api/admin/bookings',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                'content-type' => 'application/json',
            ],
            (string) json_encode($mutation),
        ));
        self::assertSame(403, $withoutCsrf->status);

        $withCsrf = $kernel->handle(new Request(
            'PATCH',
            '/api/admin/bookings',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                $this->csrfHeader() => $csrf,
                'content-type' => 'application/json',
            ],
            (string) json_encode($mutation),
        ));
        self::assertSame(200, $withCsrf->status);
        self::assertSame('Cliente HTTP', $withCsrf->decodedBody()['booking']['customerName'] ?? null);
    }

    public function testConcurrentPublicApiRequestsConfirmExactlyOneLifecycle(): void
    {
        // Make the fixture visible to independent worker connections rather than
        // leaving it inside this test's ordinary rollback-only transaction.
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->bookingServices->provision('lips', 'Lèvres', 30, 15, 15, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);

        // Hold the database row first. Both independent PHP processes signal
        // readiness, then block on this exact SELECT ... FOR UPDATE boundary.
        $this->database->beginTransaction();
        $lock = $this->database->fetchOne(
            "SELECT resource_key FROM booking_resource_locks WHERE resource_key = 'primary' FOR UPDATE",
        );
        self::assertSame('primary', $lock['resource_key'] ?? null);

        $workers = [];
        foreach ([1, 2] as $index => $client) {
            $ready = $this->root . "/worker-{$index}.ready";
            $pipes = [];
            $process = proc_open(
                [PHP_BINARY, __DIR__ . '/BookingConcurrencyWorker.php', 'brows', $ready, (string) $client],
                [
                    0 => ['pipe', 'r'],
                    1 => ['pipe', 'w'],
                    2 => ['pipe', 'w'],
                ],
                $pipes,
            );
            self::assertIsResource($process);
            fclose($pipes[0]);
            $workers[] = ['process' => $process, 'pipes' => $pipes, 'ready' => $ready];
        }

        $deadline = microtime(true) + 5.0;
        do {
            $ready = array_filter($workers, static fn (array $worker): bool => is_file($worker['ready']));
            if (\count($ready) === 2) {
                break;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);
        self::assertCount(2, $ready, 'both workers did not reach the database lock');

        $this->database->rollBack();
        $outcomes = [];
        foreach ($workers as $worker) {
            $stdout = trim((string) stream_get_contents($worker['pipes'][1]));
            $stderr = trim((string) stream_get_contents($worker['pipes'][2]));
            fclose($worker['pipes'][1]);
            fclose($worker['pipes'][2]);
            self::assertSame(0, proc_close($worker['process']), $stderr);
            $outcomes[] = str_starts_with($stdout, 'CONFIRMED ') ? '201 CONFIRMED' : $stdout;
        }
        sort($outcomes);

        self::assertSame(['201 CONFIRMED', '409 SLOT_UNAVAILABLE'], $outcomes);
        $booking = $this->database->fetchOne(
            'SELECT id, state, service_key, starts_at_utc FROM bookings',
        );
        self::assertNotNull($booking);
        self::assertSame('confirmed', $booking['state']);
        self::assertSame('brows', $booking['service_key']);
        self::assertSame('2026-06-15 07:00:00.000', $booking['starts_at_utc']);

        $history = $this->database->fetchAll(
            'SELECT event_type, actor_type FROM booking_history WHERE booking_id = :booking',
            ['booking' => $booking['id']],
        );
        self::assertSame([['event_type' => 'created', 'actor_type' => 'public']], $history);

        $notifications = $this->database->fetchAll(
            'SELECT job_type, channel, status, idempotency_key FROM notification_jobs'
            . ' WHERE booking_id = :booking ORDER BY id',
            ['booking' => $booking['id']],
        );
        self::assertSame(
            ['booking_confirmation', 'booking_reminder'],
            array_column($notifications, 'job_type'),
        );
        self::assertSame(['email', 'email'], array_column($notifications, 'channel'));
        self::assertSame(['pending', 'pending'], array_column($notifications, 'status'));
        self::assertCount(2, array_unique(array_column($notifications, 'idempotency_key')));
    }

    // --- ESZ-146: one serialization boundary for booking and bookability ----
    //
    // Create and move already lock the singleton `booking_resource_locks.primary`
    // row before re-reading service/availability state. ESZ-146 makes every
    // bookability mutation — weekly replacement, date exception open/close/remove,
    // service provisioning that changes is_active/duration/buffers — take the same
    // boundary first, inside its own transaction. The first acquirer is ordered
    // first; a create/move that starts behind a committed mutation re-reads the
    // new state and can confirm only a still-valid slot.
    //
    // The proofs below are deterministic, with no timing sleep as the primary
    // correctness argument. Two parent connections hold chosen row locks; the
    // worker processes signal readiness, then block on the real MySQL row locks.
    // Releasing the parent locks in the chosen order forces the two linearization
    // orders: mutation-first (the mutation owns the boundary, the create/move
    // waits behind it) and booking-first (the create/move owns the boundary, the
    // mutation waits behind it). Final DB state is asserted, not only exit codes.

    private const ESZ146_SLOT = '2026-06-15T07:00:00.000Z';
    private const ESZ146_MOVE_TARGET = '2026-06-15T07:30:00.000Z';

    /** Leaves the wrapper, truncates and commits the canonical ESZ-146 fixture. */
    private function esz146Seed(): void
    {
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);
    }

    /** @return array{reference: string} */
    private function esz146SeedSourceBooking(): array
    {
        $booking = $this->bookingApi->create($this->publicBookingRequest('brows', self::ESZ146_SLOT));

        return ['reference' => $booking['reference']];
    }

    /** Holds the availability revision row on $connection (the mutation's pause). */
    private function esz146PauseOnRevision(Database $connection): void
    {
        $row = $connection->fetchOne(
            "SELECT setting_key FROM system_settings WHERE setting_key = 'availability.revision' FOR UPDATE",
        );
        self::assertSame('availability.revision', $row['setting_key'] ?? null);
    }

    /** Holds the brows service row on $connection (create/provision's pause). */
    private function esz146PauseOnService(Database $connection): void
    {
        $row = $connection->fetchOne(
            'SELECT service_key FROM booking_services WHERE service_key = :key FOR UPDATE',
            ['key' => 'brows'],
        );
        self::assertSame('brows', $row['service_key'] ?? null);
    }

    /** Holds one booking row on $connection (move's pause, after the boundary). */
    private function esz146PauseOnBooking(Database $connection, string $reference): void
    {
        $row = $connection->fetchOne(
            'SELECT id FROM bookings WHERE reference = :reference FOR UPDATE',
            ['reference' => $reference],
        );
        self::assertNotNull($row);
    }

    private function esz146LockSingleton(Database $connection): void
    {
        $row = $connection->fetchOne(
            "SELECT resource_key FROM booking_resource_locks WHERE resource_key = 'primary' FOR UPDATE",
        );
        self::assertSame('primary', $row['resource_key'] ?? null);
    }

    /**
     * Spawns one worker process that signals readiness and then blocks on the
     * booking serialization boundary or on the parent-held pause row.
     *
     * @param list<string> $arguments Worker arguments after the script name;
     *     the readiness path is appended by the helper.
     * @return array{process: resource, pipes: array<int, resource>, ready: string}
     */
    private function esz146Spawn(string $script, string $tag, array $arguments): array
    {
        $ready = $this->root . "/esz146-{$tag}.ready";
        $pipes = [];
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/' . $script, ...$arguments, $ready],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        self::assertIsResource($process);
        fclose($pipes[0]);

        return ['process' => $process, 'pipes' => $pipes, 'ready' => $ready];
    }

    /** @param array{process: resource, pipes: array<int, resource>, ready: string} $worker */
    private function esz146AwaitReady(array $worker, string $label, float $seconds = 20.0): void
    {
        $deadline = microtime(true) + $seconds;
        do {
            if (is_file($worker['ready'])) {
                return;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);
        self::fail("worker {$label} never signalled readiness");
    }

    /**
     * Reads a worker to EOF (its exit), then reaps it.
     *
     * @param array{process: resource, pipes: array<int, resource>, ready: string} $worker
     * @return array{int, string, string} exit code, stdout, stderr
     */
    private function esz146Reap(array $worker, string $label, float $seconds = 60.0): array
    {
        // stream_get_contents blocks until the child closes its stdout, i.e.
        // until it exits, so a worker still parked on a row lock would hang
        // here; the tests release every parent-held lock before reaping.
        $deadline = microtime(true) + $seconds;
        $status = proc_get_status($worker['process']);
        while ($status['running']) {
            if (microtime(true) > $deadline) {
                proc_terminate($worker['process']);
                self::fail("worker {$label} did not finish within {$seconds}s");
            }
            usleep(20_000);
            $status = proc_get_status($worker['process']);
        }

        $stdout = trim((string) stream_get_contents($worker['pipes'][1]));
        $stderr = trim((string) stream_get_contents($worker['pipes'][2]));
        fclose($worker['pipes'][1]);
        fclose($worker['pipes'][2]);

        return [proc_close($worker['process']), $stdout, $stderr];
    }

    /** Rolls back every connection that still holds a lock. */
    private function esz146Release(Database ...$connections): void
    {
        foreach ($connections as $connection) {
            if ($connection->inTransaction()) {
                $connection->rollBack();
            }
        }
    }

    public function testEs146CreateCannotConfirmBehindACommittedClose(): void
    {
        // Mutation-first: the close owns the serialization boundary while the
        // create waits behind it, then commits; the create re-reads the closed
        // day and cannot confirm.
        $this->esz146Seed();
        $pause = TestDatabase::connectSeparately();
        $pause->beginTransaction();
        $this->esz146PauseOnRevision($pause);

        $this->database->beginTransaction();
        $this->esz146LockSingleton($this->database);
        $mutation = $this->esz146Spawn('BookabilityMutationWorker.php', 't1-m', ['close', '2026-06-15']);
        $this->esz146AwaitReady($mutation, 'close');
        $this->database->rollBack(); // the close alone acquires the boundary
        $booking = $this->esz146Spawn('BookingMutationWorker.php', 't1-b', ['create', 'brows', self::ESZ146_SLOT]);
        $this->esz146AwaitReady($booking, 'create'); // blocked behind the close

        $pause->rollBack(); // the close commits; only then can the create run
        [$exit, $out, $err] = $this->esz146Reap($mutation, 'close');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('OK close', $out);

        [$exit, $out, $err] = $this->esz146Reap($booking, 'create');
        self::assertSame(1, $exit, $err);
        self::assertStringContainsString('SlotUnavailableException', $out);

        $this->esz146Release($pause);
        self::assertSame(
            '0',
            (string) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n'] ?? ''),
            'no booking may exist on a day that was closed before the create ran',
        );
        $exception = $this->database->fetchOne(
            "SELECT exception_kind FROM availability_exceptions WHERE exception_date = '2026-06-15'",
        );
        self::assertSame('closed', $exception['exception_kind'] ?? null);
    }

    public function testEs146CreateCannotConfirmBehindAWeeklyReplacementRemovingTheSlot(): void
    {
        $this->esz146Seed();
        $pause = TestDatabase::connectSeparately();
        $pause->beginTransaction();
        $this->esz146PauseOnRevision($pause);

        $this->database->beginTransaction();
        $this->esz146LockSingleton($this->database);
        $mutation = $this->esz146Spawn(
            'BookabilityMutationWorker.php',
            't2-m',
            ['replace-weekly', '2', '09:00', '11:00'], // Tuesday only: the Monday slot disappears
        );
        $this->esz146AwaitReady($mutation, 'replace-weekly');
        $this->database->rollBack();
        $booking = $this->esz146Spawn('BookingMutationWorker.php', 't2-b', ['create', 'brows', self::ESZ146_SLOT]);
        $this->esz146AwaitReady($booking, 'create');

        $pause->rollBack();
        [$exit, $out, $err] = $this->esz146Reap($mutation, 'replace-weekly');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('OK replace-weekly', $out);

        [$exit, $out, $err] = $this->esz146Reap($booking, 'create');
        self::assertSame(1, $exit, $err);
        self::assertStringContainsString('SlotUnavailableException', $out);

        $this->esz146Release($pause);
        self::assertSame(
            '0',
            (string) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n'] ?? ''),
        );
        $weekdays = array_column(
            $this->database->fetchAll('SELECT weekday_iso FROM availability_rules'),
            'weekday_iso',
        );
        self::assertSame([2], $weekdays, 'the replacement set is the only schedule left');
    }

    public function testEs146CreateCannotConfirmBehindAServiceDisable(): void
    {
        $this->esz146Seed();
        $pause = TestDatabase::connectSeparately();
        $pause->beginTransaction();
        $this->esz146PauseOnService($pause);

        $this->database->beginTransaction();
        $this->esz146LockSingleton($this->database);
        $mutation = $this->esz146Spawn(
            'BookabilityMutationWorker.php',
            't3-m',
            ['provision', 'brows', '30', '0', '0', '0'],
        );
        $this->esz146AwaitReady($mutation, 'provision');
        $this->database->rollBack();
        $booking = $this->esz146Spawn('BookingMutationWorker.php', 't3-b', ['create', 'brows', self::ESZ146_SLOT]);
        $this->esz146AwaitReady($booking, 'create');

        $pause->rollBack();
        [$exit, $out, $err] = $this->esz146Reap($mutation, 'provision');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('OK provision', $out);

        [$exit, $out, $err] = $this->esz146Reap($booking, 'create');
        self::assertSame(1, $exit, $err);
        self::assertStringContainsString('BookingValidationException', $out);
        self::assertStringContainsString('not actively bookable', $err);

        $this->esz146Release($pause);
        self::assertSame(
            '0',
            (string) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n'] ?? ''),
        );
        self::assertSame(
            '0',
            (string) ($this->database->fetchOne(
                'SELECT is_active FROM booking_services WHERE service_key = :key',
                ['key' => 'brows'],
            )['is_active'] ?? ''),
            'the disable committed before the create could confirm',
        );
    }

    public function testEs146CreateCannotConfirmBehindADurationChangeInvalidatingTheSlot(): void
    {
        // 150 minutes no longer fits the 09:00-11:00 window, so the Monday
        // slot the create asks for ceases to exist the moment the provisioning
        // commits.
        $this->esz146Seed();
        $pause = TestDatabase::connectSeparately();
        $pause->beginTransaction();
        $this->esz146PauseOnService($pause);

        $this->database->beginTransaction();
        $this->esz146LockSingleton($this->database);
        $mutation = $this->esz146Spawn(
            'BookabilityMutationWorker.php',
            't4-m',
            ['provision', 'brows', '150', '0', '0', '1'],
        );
        $this->esz146AwaitReady($mutation, 'provision');
        $this->database->rollBack();
        $booking = $this->esz146Spawn('BookingMutationWorker.php', 't4-b', ['create', 'brows', self::ESZ146_SLOT]);
        $this->esz146AwaitReady($booking, 'create');

        $pause->rollBack();
        [$exit, $out, $err] = $this->esz146Reap($mutation, 'provision');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('OK provision', $out);

        [$exit, $out, $err] = $this->esz146Reap($booking, 'create');
        self::assertSame(1, $exit, $err);
        self::assertStringContainsString('SlotUnavailableException', $out);

        $this->esz146Release($pause);
        self::assertSame(
            '0',
            (string) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n'] ?? ''),
        );
        self::assertSame(
            '150',
            (string) ($this->database->fetchOne(
                'SELECT duration_minutes FROM booking_services WHERE service_key = :key',
                ['key' => 'brows'],
            )['duration_minutes'] ?? ''),
        );
    }

    public function testEs146MoveCannotConfirmBehindAnAvailabilityMutation(): void
    {
        $this->esz146Seed();
        $source = $this->esz146SeedSourceBooking(); // confirmed booking at 07:00
        $pause = TestDatabase::connectSeparately();
        $pause->beginTransaction();
        $this->esz146PauseOnRevision($pause);

        $this->database->beginTransaction();
        $this->esz146LockSingleton($this->database);
        $mutation = $this->esz146Spawn('BookabilityMutationWorker.php', 't5-m', ['close', '2026-06-15']);
        $this->esz146AwaitReady($mutation, 'close');
        $this->database->rollBack();
        $mover = $this->esz146Spawn(
            'BookingMutationWorker.php',
            't5-mv',
            ['move', $source['reference'], self::ESZ146_MOVE_TARGET],
        );
        $this->esz146AwaitReady($mover, 'move');

        $pause->rollBack();
        [$exit, $out, $err] = $this->esz146Reap($mutation, 'close');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('OK close', $out);

        [$exit, $out, $err] = $this->esz146Reap($mover, 'move');
        self::assertSame(1, $exit, $err);
        self::assertStringContainsString('SlotUnavailableException', $out);

        $this->esz146Release($pause);
        $stored = $this->database->fetchOne(
            'SELECT starts_at_utc FROM bookings WHERE reference = :reference',
            ['reference' => $source['reference']],
        );
        self::assertSame(
            '2026-06-15 07:00:00.000',
            $stored['starts_at_utc'] ?? null,
            'the move must not have happened',
        );
        $exception = $this->database->fetchOne(
            "SELECT exception_kind FROM availability_exceptions WHERE exception_date = '2026-06-15'",
        );
        self::assertSame('closed', $exception['exception_kind'] ?? null);
    }

    public function testEs146BookingFirstCreateCommitsBeforeTheCloseWithoutDeadlock(): void
    {
        // Booking-first: the create owns the boundary; the close waits behind
        // it and commits only after the booking exists. The booking row on the
        // closed day is the observable proof of the order: had the close gone
        // first, the create would have been refused.
        $this->esz146Seed();
        $pause = TestDatabase::connectSeparately();
        $pause->beginTransaction();
        $this->esz146PauseOnService($pause); // parks the create after its boundary

        $this->database->beginTransaction();
        $this->esz146LockSingleton($this->database);
        $booking = $this->esz146Spawn('BookingMutationWorker.php', 't6-b', ['create', 'brows', self::ESZ146_SLOT]);
        $this->esz146AwaitReady($booking, 'create');
        $this->database->rollBack(); // the create alone acquires the boundary
        $mutation = $this->esz146Spawn('BookabilityMutationWorker.php', 't6-m', ['close', '2026-06-15']);
        $this->esz146AwaitReady($mutation, 'close'); // waits behind the create

        $pause->rollBack(); // the create commits; only then the close
        [$exit, $out, $err] = $this->esz146Reap($booking, 'create');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('CONFIRMED ', $out);

        [$exit, $out, $err] = $this->esz146Reap($mutation, 'close');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('OK close', $out);

        $this->esz146Release($pause);
        $bookingRow = $this->database->fetchOne(
            "SELECT starts_at_utc FROM bookings WHERE starts_at_utc = '2026-06-15 07:00:00.000'",
        );
        self::assertNotNull($bookingRow, 'the booking committed before the close');
        $exception = $this->database->fetchOne(
            "SELECT exception_kind FROM availability_exceptions WHERE exception_date = '2026-06-15'",
        );
        self::assertSame('closed', $exception['exception_kind'] ?? null, 'the close followed the booking');
    }

    public function testEs146BookingFirstMoveCommitsBeforeTheCloseWithoutDeadlock(): void
    {
        $this->esz146Seed();
        $source = $this->esz146SeedSourceBooking();
        $pause = TestDatabase::connectSeparately();
        $pause->beginTransaction();
        $this->esz146PauseOnBooking($pause, $source['reference']); // parks the move after its boundary

        $this->database->beginTransaction();
        $this->esz146LockSingleton($this->database);
        $mover = $this->esz146Spawn(
            'BookingMutationWorker.php',
            't7-mv',
            ['move', $source['reference'], self::ESZ146_MOVE_TARGET],
        );
        $this->esz146AwaitReady($mover, 'move');
        $this->database->rollBack(); // the move alone acquires the boundary
        $mutation = $this->esz146Spawn('BookabilityMutationWorker.php', 't7-m', ['close', '2026-06-15']);
        $this->esz146AwaitReady($mutation, 'close');

        $pause->rollBack();
        [$exit, $out, $err] = $this->esz146Reap($mover, 'move');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('MOVED ', $out);

        [$exit, $out, $err] = $this->esz146Reap($mutation, 'close');
        self::assertSame(0, $exit, $err);
        self::assertStringContainsString('OK close', $out);

        $this->esz146Release($pause);
        $stored = $this->database->fetchOne(
            'SELECT starts_at_utc FROM bookings WHERE reference = :reference',
            ['reference' => $source['reference']],
        );
        self::assertSame('2026-06-15 07:30:00.000', $stored['starts_at_utc'] ?? null, 'the move committed first');
        $exception = $this->database->fetchOne(
            "SELECT exception_kind FROM availability_exceptions WHERE exception_date = '2026-06-15'",
        );
        self::assertSame('closed', $exception['exception_kind'] ?? null);
    }

    public function testEs146KeepsEs137StaleWritersAndRepeatedProvisioningIntact(): void
    {
        // ESZ-137 regression: after the boundary is acquired, a stale
        // expectedRevision is still a deterministic conflict that writes
        // nothing — and provisioning, which now shares the boundary, stays
        // repeat-safe.
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);

        $first = $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        self::assertTrue($first['created']);
        $second = $this->bookingServices->provision('brows', 'Sourcils premium', 30, 5, 5, true);
        self::assertFalse($second['created']);
        self::assertSame(30, $second['service']->durationMinutes);
        self::assertSame(5, $second['service']->bufferBeforeMinutes);

        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);
        self::assertSame(1, $this->availabilityHead());

        // A stale weekly writer (revision 0 against current 1) is refused and
        // leaves the schedule byte-for-byte as it was.
        $refused = false;
        try {
            $this->availability->replaceWeeklyRules(0, [$this->weeklyRule(2, '10:00', '12:00')]);
        } catch (AvailabilityRevisionConflictException $conflict) {
            $refused = true;
            self::assertSame(0, $conflict->expectedRevision);
            self::assertSame(1, $conflict->currentRevision);
        }
        self::assertTrue($refused, 'a stale writer must fail deterministically');
        self::assertSame(1, $this->availabilityHead());
        $weekdays = array_column(
            $this->database->fetchAll('SELECT weekday_iso FROM availability_rules'),
            'weekday_iso',
        );
        self::assertSame([1], $weekdays, 'the refused replacement wrote nothing');

        // The same holds for a stale cross-kind writer: a close submitted
        // against an older revision is refused even though the date it names
        // is still open.
        $this->availability->putClosedException($this->availabilityHead(), '2026-06-15', 'holiday');
        self::assertSame(2, $this->availabilityHead());

        $this->expectException(AvailabilityRevisionConflictException::class);
        $this->availability->putClosedException(1, '2026-06-16', 'stale close'); // current revision is 2
    }

    // --- ESZ-139: per-booking optimistic concurrency ----------------------
    //
    // A booking row's canonical UTC millisecond `updatedAt` is its V1
    // optimistic-concurrency token: admin responses expose it, and update,
    // move and cancel send it back as expectedUpdatedAt. Under the
    // authoritative row lock the server compares it byte-for-byte with the
    // current row before any write, history append or notification
    // scheduling; a mismatch is BookingRevisionConflictException (409
    // REVISION_CONFLICT on the wire) and writes nothing. A successful
    // mutation stores one derived instant, strictly later than the token it
    // was granted against, even when the application clock returns the same
    // millisecond or moves backward.

    /** Leaves the wrapper, truncates and commits the canonical ESZ-139 fixture. */
    private function esz139Seed(string $slot = '2026-06-15T07:00:00.000Z'): string
    {
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);

        return (string) $this->bookingApi->create($this->publicBookingRequest('brows', $slot))['reference'];
    }

    public function testEs139StaleContactUpdateCannotOverwriteANewerOne(): void
    {
        $reference = $this->esz139Seed();
        $token = $this->bookingToken($reference);

        // Client A wins with the shared token and advances it.
        $winner = $this->adminMutateFresh('update', $reference, [
            'customerName' => 'Cliente Gagnante',
            'customerEmail' => 'gagnante@example.test',
            'customerPhone' => null,
            'customerNote' => 'modifiée par A',
        ]);
        self::assertGreaterThan(0, strcmp($winner['booking']['updatedAt'], $token));

        // Client B still holds the old token: refused before any write.
        try {
            $this->bookingApi->adminMutate([
                'action' => 'update',
                'reference' => $reference,
                'expectedUpdatedAt' => $token,
                'customerName' => 'Cliente Périmée',
                'customerEmail' => 'perimee@example.test',
                'customerPhone' => null,
                'customerNote' => null,
            ]);
            self::fail('a stale contact update was accepted');
        } catch (BookingRevisionConflictException $conflict) {
            self::assertSame($token, $conflict->expectedUpdatedAt);
            self::assertSame($winner['booking']['updatedAt'], $conflict->currentUpdatedAt);
        }

        $stored = $this->bookings->find($reference);
        self::assertNotNull($stored);
        self::assertSame('Cliente Gagnante', $stored->customerName);
        self::assertSame('gagnante@example.test', $stored->customerEmail);
        self::assertSame(
            $winner['booking']['updatedAt'],
            $stored->updatedAt,
            'the refused update must not move the token',
        );
        self::assertSame(
            ['created', 'customer_updated'],
            array_column($this->database->fetchAll(
                'SELECT event_type FROM booking_history WHERE booking_id = :booking ORDER BY id',
                ['booking' => $stored->id],
            ), 'event_type'),
        );
        self::assertCount(2, $this->notificationRows($stored->id), 'a stale update schedules nothing');
    }

    public function testEs139StaleMoveAfterContactUpdateWritesNoHistoryOrNotification(): void
    {
        $reference = $this->esz139Seed();
        $token = $this->bookingToken($reference);

        $winner = $this->adminMutateFresh('update', $reference, [
            'customerName' => 'Cliente Gagnante',
            'customerEmail' => 'gagnante@example.test',
            'customerPhone' => null,
            'customerNote' => null,
        ]);
        $currentToken = (string) $winner['booking']['updatedAt'];
        $booking = $this->bookings->find($reference);
        self::assertNotNull($booking);
        $jobsBefore = count($this->notificationRows($booking->id));

        try {
            $this->bookingApi->adminMutate([
                'action' => 'move',
                'reference' => $reference,
                'expectedUpdatedAt' => $token,
                'startsAtUtc' => '2026-06-15T08:00:00.000Z',
            ]);
            self::fail('a stale move was accepted');
        } catch (BookingRevisionConflictException $conflict) {
            self::assertSame($token, $conflict->expectedUpdatedAt);
            self::assertSame($currentToken, $conflict->currentUpdatedAt);
        }

        $stored = $this->bookings->find($reference);
        self::assertNotNull($stored);
        self::assertSame('confirmed', $stored->state->value);
        self::assertSame('2026-06-15 07:00:00.000', $stored->startsAtUtc, 'the stale move must not move the row');
        self::assertSame($currentToken, $stored->updatedAt);
        self::assertSame(
            ['created', 'customer_updated'],
            array_column($this->database->fetchAll(
                'SELECT event_type FROM booking_history WHERE booking_id = :booking ORDER BY id',
                ['booking' => $stored->id],
            ), 'event_type'),
        );
        self::assertCount($jobsBefore, $this->notificationRows($stored->id), 'a stale move schedules no moved job');
    }

    public function testEs139MoveThenStaleCancelAndCancelThenStaleMove(): void
    {
        $reference = $this->esz139Seed();
        $token = $this->bookingToken($reference);

        // A fresh move advances the token to tokenAfterMove.
        $moved = $this->adminMutateFresh('move', $reference, ['startsAtUtc' => '2026-06-15T08:00:00.000Z']);
        $tokenAfterMove = (string) $moved['booking']['updatedAt'];
        self::assertGreaterThan(0, strcmp($tokenAfterMove, $token));

        // A cancel still holding the pre-move token is a stale conflict: the
        // row stays confirmed and no cancellation history or job appears.
        try {
            $this->bookingApi->adminMutate([
                'action' => 'cancel',
                'reference' => $reference,
                'expectedUpdatedAt' => $token,
                'reason' => 'stale cancel',
            ]);
            self::fail('a stale cancel after a move was accepted');
        } catch (BookingRevisionConflictException $conflict) {
            self::assertSame($token, $conflict->expectedUpdatedAt);
            self::assertSame($tokenAfterMove, $conflict->currentUpdatedAt);
        }

        $stored = $this->bookings->find($reference);
        self::assertNotNull($stored);
        self::assertSame('confirmed', $stored->state->value);
        self::assertSame(
            ['created', 'moved'],
            array_column($this->database->fetchAll(
                'SELECT event_type FROM booking_history WHERE booking_id = :booking ORDER BY id',
                ['booking' => $stored->id],
            ), 'event_type'),
        );
        self::assertSame([], array_filter(
            $this->notificationRows($stored->id),
            static fn (array $row): bool => $row['job_type'] === 'booking_cancellation',
        ));

        // A fresh cancel succeeds; then a move holding the pre-cancel token is
        // refused even though the state machine would otherwise say the move
        // target is free — the token check precedes the transition checks.
        $cancelled = $this->adminMutateFresh('cancel', $reference, ['reason' => 'décision cliente']);
        $tokenAfterCancel = (string) $cancelled['booking']['updatedAt'];
        self::assertGreaterThan(0, strcmp($tokenAfterCancel, $tokenAfterMove));

        try {
            $this->bookingApi->adminMutate([
                'action' => 'move',
                'reference' => $reference,
                'expectedUpdatedAt' => $tokenAfterMove,
                'startsAtUtc' => '2026-06-15T09:00:00.000Z',
            ]);
            self::fail('a stale move after a cancel was accepted');
        } catch (BookingRevisionConflictException $conflict) {
            self::assertSame($tokenAfterMove, $conflict->expectedUpdatedAt);
            self::assertSame($tokenAfterCancel, $conflict->currentUpdatedAt);
        }

        $final = $this->bookings->find($reference);
        self::assertNotNull($final);
        self::assertSame('cancelled', $final->state->value);
        self::assertSame('2026-06-15 08:00:00.000', $final->startsAtUtc, 'the stale move must not move the row');
        self::assertSame(
            ['created', 'moved', 'cancelled'],
            array_column($this->database->fetchAll(
                'SELECT event_type FROM booking_history WHERE booking_id = :booking ORDER BY id',
                ['booking' => $final->id],
            ), 'event_type'),
        );
    }

    public function testEs139TwoProcessesWithOneTokenYieldExactlyOneSuccess(): void
    {
        $reference = $this->esz139Seed();
        $token = $this->bookingToken($reference);

        // Hold the booking row; both real processes signal readiness while
        // parked behind it, each replaying the very same token. Releasing the
        // row lets exactly one of them pass; whichever wins commits and mints
        // a newer token, and the other re-reads the newer row under the lock
        // and must be refused as stale — the outcome counts hold for either
        // grant order.
        $this->database->beginTransaction();
        $row = $this->database->fetchOne(
            'SELECT id FROM bookings WHERE reference = :reference FOR UPDATE',
            ['reference' => $reference],
        );
        self::assertNotNull($row);

        $first = $this->esz146Spawn(
            'BookingMutationWorker.php',
            'esz139-a',
            ['update', $reference, 'Cliente Processus A', $token],
        );
        $this->esz146AwaitReady($first, 'first updater');
        $second = $this->esz146Spawn(
            'BookingMutationWorker.php',
            'esz139-b',
            ['update', $reference, 'Cliente Processus B', $token],
        );
        $this->esz146AwaitReady($second, 'second updater');

        $this->database->rollBack();

        [$firstExit, $firstOut, $firstErr] = $this->esz146Reap($first, 'first updater');
        [$secondExit, $secondOut, $secondErr] = $this->esz146Reap($second, 'second updater');
        $exits = [$firstExit, $secondExit];
        sort($exits);
        self::assertSame([0, 1], $exits, $firstErr . "\n" . $secondErr);
        $winners = array_filter(
            [$firstOut, $secondOut],
            static fn (string $out): bool => str_starts_with($out, 'UPDATED '),
        );
        $losers = array_filter(
            [$firstOut, $secondOut],
            static fn (string $out): bool => str_starts_with($out, 'FAILED '),
        );
        self::assertCount(1, $winners, 'exactly one process may succeed with the shared token');
        self::assertCount(1, $losers, 'exactly one process must lose with the shared token');
        self::assertStringContainsString(
            'BookingRevisionConflictException',
            (string) reset($losers),
            $firstErr . "\n" . $secondErr,
        );

        $stored = $this->bookings->find($reference);
        self::assertNotNull($stored);
        self::assertContains(
            $stored->customerName,
            ['Cliente Processus A', 'Cliente Processus B'],
        );
        self::assertGreaterThan(0, strcmp($stored->updatedAt, $token), 'the winner must mint a strictly newer token');
        self::assertSame(
            ['created', 'customer_updated'],
            array_column($this->database->fetchAll(
                'SELECT event_type FROM booking_history WHERE booking_id = :booking ORDER BY id',
                ['booking' => $stored->id],
            ), 'event_type'),
            'exactly one process may append customer_updated history',
        );
    }

    public function testEs139SameOrBackwardClockStillMintsStrictlyNewerTokens(): void
    {
        // Part A — the suite clock is frozen on NOW, so three successive
        // mutations granted fresh tokens all happen "in the same millisecond".
        // Each must still mint exactly one millisecond later than the token it
        // was granted against.
        $reference = $this->esz139Seed();
        self::assertSame('2026-06-13T12:00:00.000Z', $this->bookingToken($reference));

        $updated = $this->adminMutateFresh('update', $reference, [
            'customerName' => 'Cliente Modifiée',
            'customerEmail' => 'modifiee@example.test',
            'customerPhone' => null,
            'customerNote' => null,
        ]);
        self::assertSame('2026-06-13T12:00:00.001Z', $updated['booking']['updatedAt']);

        $moved = $this->adminMutateFresh('move', $reference, ['startsAtUtc' => '2026-06-15T08:00:00.000Z']);
        self::assertSame('2026-06-13T12:00:00.002Z', $moved['booking']['updatedAt']);

        $cancelled = $this->adminMutateFresh('cancel', $reference, ['reason' => 'test']);
        self::assertSame('2026-06-13T12:00:00.003Z', $cancelled['booking']['updatedAt']);

        // One derived instant drives every advancing state timestamp: the
        // stored row agrees with the wire token, and the DATETIME(3) facts
        // carry the same millisecond.
        $stored = $this->bookings->find($reference);
        self::assertNotNull($stored);
        self::assertSame('2026-06-13T12:00:00.003Z', $stored->updatedAt);
        self::assertSame('2026-06-13T12:00:00.003Z', $stored->stateChangedAt);
        self::assertSame('2026-06-13 12:00:00.003', $stored->cancelledAtUtc);
        foreach ([$updated, $moved, $cancelled] as $response) {
            self::assertMatchesRegularExpression(
                '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/D',
                $response['booking']['updatedAt'],
                'the token keeps the canonical UTC millisecond form',
            );
        }

        // Part B — an application clock that reads one second EARLIER than the
        // row's token cannot mint an older or equal token: the mutation still
        // advances to token + 1 ms.
        $referenceB = $this->esz139Seed('2026-06-15T08:00:00.000Z');
        $tokenB = $this->bookingToken($referenceB);
        self::assertSame('2026-06-13T12:00:00.000Z', $tokenB);

        $backward = PdoBookingApi::createDefault(
            $this->database,
            new FrozenClock('2026-06-13T11:59:59.000Z'),
            $this->bookingContract,
            NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
        );
        $won = $backward->adminMutate([
            'action' => 'update',
            'reference' => $referenceB,
            'expectedUpdatedAt' => $tokenB,
            'customerName' => 'Cliente Horloge Retardée',
            'customerEmail' => 'retardee@example.test',
            'customerPhone' => null,
            'customerNote' => null,
        ]);
        self::assertSame('2026-06-13T12:00:00.001Z', $won['booking']['updatedAt']);
    }

    public function testEs139FreshTokenAfterAConflictAllowsTheNextMutation(): void
    {
        $reference = $this->esz139Seed();
        $token = $this->bookingToken($reference);
        $winner = $this->adminMutateFresh('update', $reference, [
            'customerName' => 'Cliente Gagnante',
            'customerEmail' => 'gagnante@example.test',
            'customerPhone' => null,
            'customerNote' => null,
        ]);
        $currentToken = (string) $winner['booking']['updatedAt'];

        $refused = false;
        try {
            $this->bookingApi->adminMutate([
                'action' => 'cancel',
                'reference' => $reference,
                'expectedUpdatedAt' => $token,
                'reason' => 'stale',
            ]);
        } catch (BookingRevisionConflictException) {
            $refused = true;
        }
        self::assertTrue($refused, 'the stale cancel must be refused');

        // The recovery the UI performs: re-read by reference, then retry with
        // the authoritative token — only that succeeds.
        $reRead = $this->bookingApi->adminQuery(['mode' => 'reference', 'reference' => $reference]);
        self::assertSame($currentToken, $reRead['bookings'][0]['updatedAt']);

        $retried = $this->bookingApi->adminMutate([
            'action' => 'cancel',
            'reference' => $reference,
            'expectedUpdatedAt' => $currentToken,
            'reason' => 'décision cliente',
        ]);
        self::assertSame('cancelled', $retried['booking']['state']);
        self::assertGreaterThan(0, strcmp($retried['booking']['updatedAt'], $currentToken));
    }

    public function testEs139BookingConflictIsHttp409RevisionConflictWithoutLeakingState(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '11:00')]);
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();

        $created = $kernel->handle(new Request(
            'POST',
            '/api/bookings',
            ['content-type' => 'application/json'],
            (string) json_encode($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z')),
        ));
        self::assertSame(201, $created->status);
        $reference = (string) ($created->decodedBody()['reference'] ?? '');

        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $login = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );
        $sessionId = self::cookieValue($login);
        /** @var array<string, mixed> $loginBody */
        $loginBody = $login->decodedBody();
        $headers = [
            'cookie' => $this->cookieName() . '=' . $sessionId,
            $this->csrfHeader() => (string) $loginBody['csrfToken'],
            'content-type' => 'application/json',
        ];

        $query = $kernel->handle(new Request(
            'POST',
            '/api/admin/bookings/query',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                'content-type' => 'application/json',
            ],
            (string) json_encode(['mode' => 'reference', 'reference' => $reference]),
        ));
        self::assertSame(200, $query->status);
        $token = (string) ($query->decodedBody()['bookings'][0]['updatedAt'] ?? '');

        $aUpdate = $kernel->handle(new Request(
            'PATCH',
            '/api/admin/bookings',
            $headers,
            (string) json_encode([
                'action' => 'update',
                'reference' => $reference,
                'expectedUpdatedAt' => $token,
                'customerName' => 'Cliente Gagnante',
                'customerEmail' => 'gagnante@example.test',
                'customerPhone' => null,
                'customerNote' => 'état interne A',
            ]),
        ));
        self::assertSame(200, $aUpdate->status);

        $stalePatch = $kernel->handle(new Request(
            'PATCH',
            '/api/admin/bookings',
            $headers,
            (string) json_encode([
                'action' => 'update',
                'reference' => $reference,
                'expectedUpdatedAt' => $token,
                'customerName' => 'Cliente Périmée',
                'customerEmail' => 'perimee@example.test',
                'customerPhone' => null,
                'customerNote' => null,
            ]),
        ));
        self::assertSame(409, $stalePatch->status);
        /** @var array<string, mixed> $body */
        $body = $stalePatch->decodedBody();
        self::assertSame(['error'], array_keys($body));
        self::assertSame(['code', 'message', 'requestId'], array_keys($body['error']));
        self::assertSame('REVISION_CONFLICT', $body['error']['code'] ?? null);
        self::assertSame(
            \Eszter\Http\ErrorCatalog::fromArtifacts(TestEnvironment::artifacts())->message('REVISION_CONFLICT'),
            $body['error']['message'] ?? null,
        );
        $internal = [
            'Cliente Gagnante',
            'gagnante@example.test',
            'état interne A',
            'expectedUpdatedAt',
            'expected',
            'currentUpdatedAt',
        ];
        foreach ($internal as $leak) {
            self::assertStringNotContainsString($leak, $stalePatch->body, 'the envelope must not leak internal state');
        }

        // A mutation without the token is refused by the schema itself.
        $missingToken = $kernel->handle(new Request(
            'PATCH',
            '/api/admin/bookings',
            $headers,
            (string) json_encode([
                'action' => 'move',
                'reference' => $reference,
                'startsAtUtc' => '2026-06-15T08:00:00.000Z',
            ]),
        ));
        self::assertSame(400, $missingToken->status);
        self::assertSame('VALIDATION_FAILED', $missingToken->decodedBody()['error']['code'] ?? null);

        // The refused stale write changed nothing: A's data is still stored,
        // with exactly one customer_updated event.
        $after = $kernel->handle(new Request(
            'POST',
            '/api/admin/bookings/query',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                'content-type' => 'application/json',
            ],
            (string) json_encode(['mode' => 'reference', 'reference' => $reference]),
        ));
        self::assertSame('Cliente Gagnante', $after->decodedBody()['bookings'][0]['customerName'] ?? null);
        self::assertSame(
            ['created', 'customer_updated'],
            array_column($after->decodedBody()['bookings'][0]['history'] ?? [], 'type'),
        );
    }

    // --- ESZ-063 / ESZ-064 / ESZ-065: availability administration -----------

    public function testWeeklyReplacementStoresTheWholeSetAndReturnsStoredState(): void
    {
        $result = $this->replaceWeekly([
            $this->weeklyRulePayload(2, '14:00', '18:00'),
            $this->weeklyRulePayload(2, '09:00', '12:30'),
            $this->weeklyRulePayload(4, '10:00', '13:00', '2026-09-01', '2026-12-31', false),
        ]);

        /** @var list<array<string, mixed>> $rules */
        $rules = $result['weeklyRules'];
        self::assertSame('Europe/Paris', $result['timezone']);
        self::assertCount(3, $rules);

        // The response is read back from storage, so it carries the repository's
        // ordering and the ids the insert assigned — neither of which the caller
        // sent. That is what the editor is required to adopt.
        self::assertSame([2, 2, 4], array_column($rules, 'weekdayIso'));
        self::assertSame(['09:00', '14:00', '10:00'], array_column($rules, 'startLocal'));
        foreach ($rules as $rule) {
            self::assertIsInt($rule['id']);
            self::assertGreaterThan(0, $rule['id']);
        }

        // Minute precision on the wire, whatever MySQL's TIME columns read back as.
        self::assertSame('12:30', $rules[0]['endLocal']);

        // Deactivation and validity bounds survive the round trip rather than
        // being normalised away.
        self::assertFalse($rules[2]['isActive']);
        self::assertSame('2026-09-01', $rules[2]['validFrom']);
        self::assertSame('2026-12-31', $rules[2]['validUntil']);

        // A replacement replaces: the previous set is gone, not merged with.
        $second = $this->replaceWeekly([
            $this->weeklyRulePayload(1, '09:00', '10:00'),
        ]);
        self::assertCount(1, $second['weeklyRules']);
        self::assertSame(1, (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM availability_rules',
        )['n'] ?? 0));
    }

    public function testARefusedWeeklyReplacementLeavesThePreviousScheduleExactlyAsItWas(): void
    {
        $this->replaceWeekly([
            $this->weeklyRulePayload(1, '09:00', '12:00'),
            $this->weeklyRulePayload(2, '09:00', '12:00'),
            $this->weeklyRulePayload(3, '09:00', '12:00'),
        ]);
        $before = $this->bookingApi->adminAvailability([
            'fromDate' => '2026-06-01',
            'untilDate' => '2026-06-30',
        ])['weeklyRules'];

        // Each of these is refused for a different reason, and each is submitted
        // with valid rules *around* the offending one, so a server that validated
        // and wrote row by row would leave part of the new set behind.
        $refusals = [
            'inverted window' => [
                $this->weeklyRulePayload(1, '09:00', '12:00'),
                $this->weeklyRulePayload(2, '18:00', '09:00'),
                $this->weeklyRulePayload(3, '09:00', '12:00'),
            ],
            'overlapping windows' => [
                $this->weeklyRulePayload(1, '09:00', '12:00'),
                $this->weeklyRulePayload(1, '11:00', '13:00'),
            ],
            'inverted validity range' => [
                $this->weeklyRulePayload(1, '09:00', '12:00'),
                $this->weeklyRulePayload(2, '09:00', '12:00', '2026-12-31', '2026-01-01'),
            ],
            'weekday outside the ISO range' => [
                $this->weeklyRulePayload(1, '09:00', '12:00'),
                $this->weeklyRulePayload(8, '09:00', '12:00'),
            ],
            'unusable fold offset' => [
                $this->weeklyRulePayload(1, '09:00', '12:00', null, null, true, '+05:30'),
            ],
        ];

        foreach ($refusals as $reason => $rules) {
            try {
                $this->replaceWeekly($rules);
                self::fail("A weekly set with an {$reason} was stored.");
            } catch (BookingValidationException) {
                self::addToAssertionCount(1);
            }

            $after = $this->bookingApi->adminAvailability([
                'fromDate' => '2026-06-01',
                'untilDate' => '2026-06-30',
            ])['weeklyRules'];

            // Not merely "still three rules": the same three rules, with the same
            // ids. Nothing was deleted and reinserted, so nothing was partial.
            self::assertSame($before, $after, "the refused replacement ({$reason}) changed the schedule");
        }
    }

    public function testAnEmptyWeeklySetIsAValidScheduleAndNotAMalformedOne(): void
    {
        $this->replaceWeekly([
            $this->weeklyRulePayload(1, '09:00', '12:00'),
        ]);

        $result = $this->replaceWeekly([]);

        self::assertSame([], $result['weeklyRules']);
        self::assertSame(0, (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM availability_rules',
        )['n'] ?? 0));
    }

    public function testAConcurrentReaderNeverObservesAPartialWeeklySchedule(): void
    {
        // Commit the fixture so an independent connection can see it; this test
        // is about what that other connection observes.
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);
        $this->replaceWeekly([
            $this->weeklyRulePayload(1, '09:00', '12:00'),
            $this->weeklyRulePayload(2, '09:00', '12:00'),
            $this->weeklyRulePayload(3, '09:00', '12:00'),
        ]);

        // Hold the rule rows that the replacement's DELETE must acquire.
        $this->database->beginTransaction();
        self::assertCount(3, $this->database->fetchAll('SELECT id FROM availability_rules FOR UPDATE'));

        $ready = $this->root . '/availability-worker.ready';
        $pipes = [];
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/AvailabilityReplacementWorker.php', $ready],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        self::assertIsResource($process);
        fclose($pipes[0]);

        $deadline = microtime(true) + 5.0;
        while (!is_file($ready) && microtime(true) < $deadline) {
            usleep(10_000);
        }
        self::assertFileExists($ready, 'the worker never reached the replacement');

        // Give it long enough that an unlocked or uncommitted delete would have
        // landed, then read. Three rules, or the test would have found a
        // half-replaced week.
        usleep(300_000);
        self::assertSame(3, (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM availability_rules',
        )['n'] ?? 0), 'a concurrent reader saw a partially replaced schedule');

        $this->database->rollBack();

        $stdout = trim((string) stream_get_contents($pipes[1]));
        $stderr = trim((string) stream_get_contents($pipes[2]));
        fclose($pipes[1]);
        fclose($pipes[2]);
        self::assertSame(0, proc_close($process), $stderr);
        self::assertSame('OK 1', $stdout);

        // And once it committed, the replacement is complete rather than additive.
        $stored = $this->database->fetchAll('SELECT weekday_iso FROM availability_rules');
        self::assertCount(1, $stored);
        self::assertSame(4, (int) $stored[0]['weekday_iso']);
    }

    public function testClosingOpeningAndRemovingAnExceptionDrivesTheComputedSlots(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        // 2026-06-15 is a Monday, so ISO weekday 1.
        $this->replaceWeekly([
            $this->weeklyRulePayload(1, '09:00', '12:00'),
        ]);

        self::assertSame(
            ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30'],
            $this->localStarts('2026-06-15'),
        );

        // A closure replaces the weekly windows with nothing.
        $closed = $this->mutateException([
            'action' => 'close',
            'localDate' => '2026-06-15',
            'note' => 'Jour férié',
        ])['exception'];
        self::assertSame('closed', $closed['kind']);
        self::assertSame([], $closed['windows']);
        self::assertSame('Jour férié', $closed['note']);
        self::assertSame([], $this->localStarts('2026-06-15'));

        // An exceptional opening replaces them with its own complete set. The
        // 09:00-12:00 weekly window is absent from the result, which is the whole
        // point: exception windows are never merged with weekly ones.
        $open = $this->mutateException([
            'action' => 'open',
            'localDate' => '2026-06-15',
            'windows' => [
                ['startLocal' => '16:00', 'endLocal' => '17:00', 'foldUtcOffset' => null],
                ['startLocal' => '14:00', 'endLocal' => '15:00', 'foldUtcOffset' => null],
            ],
            'note' => null,
        ])['exception'];
        self::assertSame('open', $open['kind']);
        self::assertSame([['14:00', '15:00'], ['16:00', '17:00']], array_map(
            static fn (array $window): array => [$window['startLocal'], $window['endLocal']],
            $open['windows'],
        ), 'exception windows are returned in local order');
        self::assertSame(
            ['14:00', '14:15', '14:30', '16:00', '16:15', '16:30'],
            $this->localStarts('2026-06-15'),
        );

        // Removing it restores the weekly behaviour, and only for that date.
        $removed = $this->mutateException([
            'action' => 'remove',
            'localDate' => '2026-06-15',
        ]);
        self::assertNull($removed['exception']);
        self::assertNull($this->availability->findException('2026-06-15'));
        self::assertSame('09:00', $this->localStarts('2026-06-15')[0] ?? null);
        self::assertCount(11, $this->localStarts('2026-06-15'));

        // Removing an exception that is not there is satisfied, not an error.
        self::assertNull($this->mutateException([
            'action' => 'remove',
            'localDate' => '2026-06-15',
        ])['exception']);
    }

    public function testExceptionMutationsRefuseEmptyInvertedOverlappingAndImpossibleWindows(): void
    {
        $refusals = [
            'no windows at all' => [],
            'an inverted window' => [
                ['startLocal' => '17:00', 'endLocal' => '14:00', 'foldUtcOffset' => null],
            ],
            'an empty window' => [
                ['startLocal' => '14:00', 'endLocal' => '14:00', 'foldUtcOffset' => null],
            ],
            'overlapping windows' => [
                ['startLocal' => '09:00', 'endLocal' => '12:00', 'foldUtcOffset' => null],
                ['startLocal' => '11:00', 'endLocal' => '14:00', 'foldUtcOffset' => null],
            ],
        ];

        foreach ($refusals as $reason => $windows) {
            try {
                $this->mutateException([
                    'action' => 'open',
                    'localDate' => '2026-07-14',
                    'windows' => $windows,
                    'note' => null,
                ]);
                self::fail("An open exception with {$reason} was stored.");
            } catch (BookingValidationException) {
                self::addToAssertionCount(1);
            }

            self::assertNull(
                $this->availability->findException('2026-07-14'),
                "the refused exception ({$reason}) was stored anyway",
            );
        }
    }

    public function testExceptionMutationsApplyTheParisDstRulesAtWriteTime(): void
    {
        // 2027-03-28: the spring-forward gap. 02:30 never happens in Paris, so it
        // is refused rather than quietly shifted to 03:30.
        try {
            $this->mutateException([
                'action' => 'open',
                'localDate' => '2027-03-28',
                'windows' => [['startLocal' => '02:30', 'endLocal' => '04:00', 'foldUtcOffset' => null]],
                'note' => null,
            ]);
            self::fail('A spring-forward boundary was stored.');
        } catch (BookingValidationException) {
            self::addToAssertionCount(1);
        }
        self::assertNull($this->availability->findException('2027-03-28'));

        // 2027-10-31: the fall-back overlap. 02:00 happens twice, so the server
        // refuses to guess which one the operator meant.
        try {
            $this->mutateException([
                'action' => 'open',
                'localDate' => '2027-10-31',
                'windows' => [['startLocal' => '02:00', 'endLocal' => '02:30', 'foldUtcOffset' => null]],
                'note' => null,
            ]);
            self::fail('An ambiguous fall-back boundary was stored without an offset.');
        } catch (BookingValidationException) {
            self::addToAssertionCount(1);
        }

        // Stated explicitly, it is accepted and the choice is what comes back.
        $stored = $this->mutateException([
            'action' => 'open',
            'localDate' => '2027-10-31',
            'windows' => [['startLocal' => '02:00', 'endLocal' => '02:30', 'foldUtcOffset' => '+01:00']],
            'note' => null,
        ])['exception'];
        self::assertSame('+01:00', $stored['windows'][0]['foldUtcOffset']);

        // On an ordinary date the field has nothing to disambiguate, so it is not
        // consulted: 10:00 on a June morning has exactly one Paris instant and a
        // stored `+01:00` cannot make it a different one. The offset is a
        // fall-back tiebreak, never a way to assert an arbitrary UTC time.
        $ordinary = $this->mutateException([
            'action' => 'open',
            'localDate' => '2027-06-15',
            'windows' => [['startLocal' => '10:00', 'endLocal' => '11:00', 'foldUtcOffset' => '+01:00']],
            'note' => null,
        ])['exception'];
        self::assertSame('10:00', $ordinary['windows'][0]['startLocal']);
        self::assertSame(
            '2027-06-15T08:00:00.000Z',
            IsoTimestamp::format($this->bookingTime->localToUtcWithFoldOffset(
                '2027-06-15 10:00:00',
                '+01:00',
            )),
            'the stored fold offset changed an unambiguous instant',
        );
    }

    public function testAvailabilityReadReturnsWeeklyRulesAndOnlyTheExceptionsInRange(): void
    {
        $this->replaceWeekly([
            $this->weeklyRulePayload(1, '09:00', '12:00'),
        ]);
        foreach (['2026-05-30', '2026-06-15', '2026-07-20'] as $date) {
            $this->mutateException([
                'action' => 'close',
                'localDate' => $date,
                'note' => null,
            ]);
        }

        $result = $this->bookingApi->adminAvailability([
            'fromDate' => '2026-06-01',
            'untilDate' => '2026-06-30',
        ]);

        self::assertSame('Europe/Paris', $result['timezone']);
        self::assertCount(1, $result['weeklyRules']);
        self::assertSame(['2026-06-15'], array_column($result['exceptions'], 'localDate'));

        // The window is bounded, so the editor cannot ask for an unbounded scan.
        try {
            $this->bookingApi->adminAvailability(['fromDate' => '2026-01-01', 'untilDate' => '2030-01-01']);
            self::fail('An unbounded availability range was accepted.');
        } catch (BookingValidationException $exception) {
            self::assertSame('untilDate', $exception->field);
        }

        try {
            $this->bookingApi->adminAvailability(['fromDate' => '2026-06-30', 'untilDate' => '2026-06-01']);
            self::fail('An inverted availability range was accepted.');
        } catch (BookingValidationException) {
            self::addToAssertionCount(1);
        }
    }

    public function testTheSummaryOrdersConfirmedBookingsAndCancellationsNeverInflateActiveCounts(): void
    {
        // The frozen clock is 2026-06-13T12:00:00Z, which is 14:00 in Paris, so
        // "today" is 2026-06-13 and 10:00 local has already happened.
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);

        $later = $this->confirmedAt('2026-06-13T15:00:00.000Z');
        $earlier = $this->confirmedAt('2026-06-13T08:00:00.000Z');
        $cancelledToday = $this->confirmedAt('2026-06-13T16:00:00.000Z');
        $upcoming = $this->confirmedAt('2026-06-15T07:00:00.000Z');
        $cancelledUpcoming = $this->confirmedAt('2026-06-16T07:00:00.000Z');
        $this->bookings->transition($cancelledToday->reference, 'cancelled', 'Cliente indisponible');
        $this->bookings->transition($cancelledUpcoming->reference, 'cancelled');

        $summary = $this->bookingApi->adminSummary(['upcomingDays' => 7]);

        self::assertSame('Europe/Paris', $summary['timezone']);
        self::assertSame('2026-06-13', $summary['todayDate']);
        self::assertSame('2026-06-19', $summary['untilDate']);
        self::assertSame([
            'todayConfirmed' => 2,
            'todayCancelled' => 1,
            'upcomingConfirmed' => 1,
            'upcomingCancelled' => 1,
        ], $summary['counts']);

        // Ascending start order, and the already-started one is still listed —
        // "today" is the operator's whole day, not the rest of it.
        self::assertSame(
            [$earlier->reference, $later->reference],
            array_column($summary['today'], 'reference'),
        );
        self::assertSame(['10:00', '17:00'], array_column($summary['today'], 'localStart'));
        self::assertSame([$upcoming->reference], array_column($summary['upcoming'], 'reference'));
        self::assertSame('2026-06-15', $summary['upcoming'][0]['localDate']);

        // The next one is the first confirmed booking that has not begun, so the
        // 10:00 that is already over is not it.
        self::assertSame('2026-06-13T15:00:00.000Z', $summary['nextConfirmedStartsAtUtc']);

        // No cancelled booking is listed anywhere, under any key.
        $references = array_merge(
            array_column($summary['today'], 'reference'),
            array_column($summary['upcoming'], 'reference'),
        );
        self::assertNotContains($cancelledToday->reference, $references);
        self::assertNotContains($cancelledUpcoming->reference, $references);

        // Cancelling a listed booking moves it between the counts rather than
        // leaving the confirmed one where it was.
        $this->bookings->transition($later->reference, 'cancelled');
        $after = $this->bookingApi->adminSummary(['upcomingDays' => 7]);
        self::assertSame(1, $after['counts']['todayConfirmed']);
        self::assertSame(2, $after['counts']['todayCancelled']);
        self::assertCount(1, $after['today']);

        // The next one is now the upcoming booking, not the cancelled 17:00: a
        // cancellation removes it from the answer rather than demoting it.
        self::assertSame('2026-06-15T07:00:00.000Z', $after['nextConfirmedStartsAtUtc']);
        self::assertNotContains(
            $later->reference,
            array_column($after['today'], 'reference'),
            'a cancelled booking stayed in the listed entries',
        );
    }

    public function testTheSummaryHorizonIsBoundedAndExcludesWhatFallsOutsideIt(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->confirmedAt('2026-06-14T07:00:00.000Z');
        $this->confirmedAt('2026-06-25T07:00:00.000Z');

        $narrow = $this->bookingApi->adminSummary(['upcomingDays' => 3]);
        self::assertSame('2026-06-15', $narrow['untilDate']);
        self::assertSame(1, $narrow['counts']['upcomingConfirmed']);

        $wide = $this->bookingApi->adminSummary(['upcomingDays' => 30]);
        self::assertSame(2, $wide['counts']['upcomingConfirmed']);

        foreach ([0, -1, 91] as $days) {
            try {
                $this->bookingApi->adminSummary(['upcomingDays' => $days]);
                self::fail("A summary horizon of {$days} days was accepted.");
            } catch (BookingValidationException $exception) {
                self::assertSame('upcomingDays', $exception->field);
            }
        }
    }

    public function testAvailabilityAdminRoutesEnforceSessionAndCsrfAgainstMysql(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();

        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $login = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );
        self::assertSame(200, $login->status);
        $sessionId = self::cookieValue($login);
        /** @var array<string, mixed> $loginBody */
        $loginBody = $login->decodedBody();
        $csrf = (string) $loginBody['csrfToken'];

        $weekly = [
            'expectedRevision' => 0,
            'rules' => [$this->weeklyRulePayload(1, '09:00', '12:00')],
        ];
        $exception = [
            'action' => 'close',
            'expectedRevision' => 1,
            'localDate' => '2026-06-15',
            'note' => null,
        ];
        $mutations = [
            ['PUT', '/api/admin/availability/weekly', $weekly],
            ['PATCH', '/api/admin/availability/exceptions', $exception],
        ];

        foreach ($mutations as [$method, $path, $body]) {
            self::assertSame(401, $kernel->handle(new Request(
                $method,
                $path,
                ['content-type' => 'application/json'],
                (string) json_encode($body),
            ))->status, "{$path} answered an anonymous caller");

            self::assertSame(403, $kernel->handle(new Request(
                $method,
                $path,
                [
                    'cookie' => $this->cookieName() . '=' . $sessionId,
                    'content-type' => 'application/json',
                ],
                (string) json_encode($body),
            ))->status, "{$path} accepted a session without CSRF");

            self::assertSame(200, $kernel->handle(new Request(
                $method,
                $path,
                [
                    'cookie' => $this->cookieName() . '=' . $sessionId,
                    $this->csrfHeader() => $csrf,
                    'content-type' => 'application/json',
                ],
                (string) json_encode($body),
            ))->status, "{$path} refused an authenticated CSRF-carrying call");
        }

        // The reads need the session and nothing else.
        $reads = [
            ['/api/admin/availability/query', ['fromDate' => '2026-06-01', 'untilDate' => '2026-06-30']],
            ['/api/admin/bookings/summary', ['upcomingDays' => 7]],
        ];

        foreach ($reads as [$path, $body]) {
            self::assertSame(401, $kernel->handle(new Request(
                'POST',
                $path,
                ['content-type' => 'application/json'],
                (string) json_encode($body),
            ))->status, "{$path} answered an anonymous caller");

            $read = $kernel->handle(new Request(
                'POST',
                $path,
                [
                    'cookie' => $this->cookieName() . '=' . $sessionId,
                    'content-type' => 'application/json',
                ],
                (string) json_encode($body),
            ));
            self::assertSame(200, $read->status, "{$path} required CSRF on a read");
            self::assertSame('no-store', $read->header('Cache-Control'));
        }

        // The write above actually reached MySQL, and the read reports it.
        $stored = $kernel->handle(new Request(
            'POST',
            '/api/admin/availability/query',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                'content-type' => 'application/json',
            ],
            (string) json_encode(['fromDate' => '2026-06-01', 'untilDate' => '2026-06-30']),
        ))->decodedBody();
        self::assertCount(1, $stored['weeklyRules']);
        self::assertSame(['2026-06-15'], array_column($stored['exceptions'], 'localDate'));
        self::assertSame(2, $stored['revision']);

        // And a destroyed session stops working immediately, on the reads too.
        self::assertSame(204, $this->logout($kernel, $sessionId, $csrf)->status);
        self::assertSame(401, $kernel->handle(new Request(
            'POST',
            '/api/admin/availability/query',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                'content-type' => 'application/json',
            ],
            (string) json_encode(['fromDate' => '2026-06-01', 'untilDate' => '2026-06-30']),
        ))->status);
    }

    public function testAvailabilityRevisionRejectsStaleWeeklyExceptionAndCrossKindHttpWrites(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();
        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $login = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );
        $sessionId = self::cookieValue($login);
        /** @var array<string, mixed> $loginBody */
        $loginBody = $login->decodedBody();
        $csrf = (string) $loginBody['csrfToken'];
        $headers = [
            'cookie' => $this->cookieName() . '=' . $sessionId,
            $this->csrfHeader() => $csrf,
            'content-type' => 'application/json',
        ];
        $readHeaders = [
            'cookie' => $this->cookieName() . '=' . $sessionId,
            'content-type' => 'application/json',
        ];
        $read = static fn () => $kernel->handle(new Request(
            'POST',
            '/api/admin/availability/query',
            $readHeaders,
            (string) json_encode(['fromDate' => '2026-06-01', 'untilDate' => '2026-06-30']),
        ));
        $write = static fn (string $method, string $path, array $body) => $kernel->handle(new Request(
            $method,
            $path,
            $headers,
            (string) json_encode($body),
        ));

        /** @var array<string, mixed> $initial */
        $initial = $read()->decodedBody();
        $revisionN = (int) $initial['revision'];
        self::assertSame(0, $revisionN);

        // Clients A and B both read N. A's complete weekly replacement wins N+1.
        $aWeekly = $write('PUT', '/api/admin/availability/weekly', [
            'expectedRevision' => $revisionN,
            'rules' => [$this->weeklyRulePayload(1, '09:00', '12:00')],
        ]);
        /** @var array<string, mixed> $aWeeklyBody */
        $aWeeklyBody = $aWeekly->decodedBody();
        self::assertSame(200, $aWeekly->status);
        self::assertSame($revisionN + 1, $aWeeklyBody['revision']);

        $bWeekly = $write('PUT', '/api/admin/availability/weekly', [
            'expectedRevision' => $revisionN,
            'rules' => [$this->weeklyRulePayload(1, '14:00', '18:00')],
        ]);
        /** @var array<string, mixed> $bWeeklyBody */
        $bWeeklyBody = $bWeekly->decodedBody();
        self::assertSame(409, $bWeekly->status);
        self::assertSame('REVISION_CONFLICT', $bWeeklyBody['error']['code']);
        self::assertNull($bWeekly->header('X-Content-Revision'));

        /** @var array<string, mixed> $afterWeeklyConflict */
        $afterWeeklyConflict = $read()->decodedBody();
        self::assertSame($revisionN + 1, $afterWeeklyConflict['revision']);
        self::assertSame(['09:00'], array_column($afterWeeklyConflict['weeklyRules'], 'startLocal'));

        // The same stale N also loses across mutation kinds, proving that the
        // weekly set and date exceptions share one global revision lock.
        $crossKind = $write('PATCH', '/api/admin/availability/exceptions', [
            'action' => 'close',
            'expectedRevision' => $revisionN,
            'localDate' => '2026-06-15',
            'note' => 'stale cross-kind write',
        ]);
        self::assertSame(409, $crossKind->status);
        /** @var array<string, mixed> $afterCrossKind */
        $afterCrossKind = $read()->decodedBody();
        self::assertSame($revisionN + 1, $afterCrossKind['revision']);
        self::assertSame([], $afterCrossKind['exceptions']);

        // A fresh exception write wins. B's same-date write from that old head
        // is refused with neither a partial window change nor a revision bump.
        $aException = $write('PATCH', '/api/admin/availability/exceptions', [
            'action' => 'close',
            'expectedRevision' => $revisionN + 1,
            'localDate' => '2026-06-15',
            'note' => 'A survives',
        ]);
        /** @var array<string, mixed> $aExceptionBody */
        $aExceptionBody = $aException->decodedBody();
        self::assertSame(200, $aException->status);
        self::assertSame($revisionN + 2, $aExceptionBody['revision']);

        $bException = $write('PATCH', '/api/admin/availability/exceptions', [
            'action' => 'open',
            'expectedRevision' => $revisionN + 1,
            'localDate' => '2026-06-15',
            'windows' => [[
                'startLocal' => '15:00',
                'endLocal' => '17:00',
                'foldUtcOffset' => null,
            ]],
            'note' => 'B stale',
        ]);
        self::assertSame(409, $bException->status);
        /** @var array<string, mixed> $afterExceptionConflict */
        $afterExceptionConflict = $read()->decodedBody();
        self::assertSame($revisionN + 2, $afterExceptionConflict['revision']);
        self::assertSame('closed', $afterExceptionConflict['exceptions'][0]['kind']);
        self::assertSame('A survives', $afterExceptionConflict['exceptions'][0]['note']);
        self::assertSame([], $afterExceptionConflict['exceptions'][0]['windows']);

        // B explicitly re-reads and retries against the new head; only that
        // fresh user action succeeds and advances the revision once.
        $freshRevision = (int) $afterExceptionConflict['revision'];
        $retried = $write('PATCH', '/api/admin/availability/exceptions', [
            'action' => 'open',
            'expectedRevision' => $freshRevision,
            'localDate' => '2026-06-15',
            'windows' => [[
                'startLocal' => '15:00',
                'endLocal' => '17:00',
                'foldUtcOffset' => null,
            ]],
            'note' => 'B fresh',
        ]);
        /** @var array<string, mixed> $retriedBody */
        $retriedBody = $retried->decodedBody();
        self::assertSame(200, $retried->status);
        self::assertSame($freshRevision + 1, $retriedBody['revision']);
        self::assertSame('open', $retriedBody['exception']['kind']);
        self::assertSame('B fresh', $retriedBody['exception']['note']);
    }

    // --- ESZ-025 / ESZ-026 end to end, against MySQL ------------------------

    public function testTheWholeAuthFlowWorksAgainstMysql(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();

        // 1. An anonymous caller obtains a CSRF token.
        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();

        self::assertSame(200, $anonymous->status);
        self::assertFalse($anonymousBody['authenticated']);

        $sessionId = self::cookieValue($anonymous);
        $token = (string) $anonymousBody['csrfToken'];

        // 2. Wrong password: 401, and the row in MySQL is still anonymous.
        $rejected = $this->login($kernel, $sessionId, $token, 'wrong-password');
        self::assertSame(401, $rejected->status);
        self::assertNull($this->sessions->find($sessionId)?->accountId);

        // 3. Correct password with a valid token: 200, and the id rotates.
        $accepted = $this->login($kernel, $sessionId, $token, self::PASSWORD);
        /** @var array<string, mixed> $body */
        $body = $accepted->decodedBody();
        $newSessionId = self::cookieValue($accepted);

        self::assertSame(200, $accepted->status);
        self::assertTrue($body['authenticated']);
        self::assertNotSame($sessionId, $newSessionId);
        self::assertNull($this->sessions->find($sessionId), 'the pre-login row survived in MySQL');

        // The account really is attached, in the database, not just in the body.
        $stored = $this->sessions->find($newSessionId);
        self::assertNotNull($stored);
        self::assertNotNull($stored->accountId);

        // ESZ-134: the committed transition includes the login record, not just
        // the session — last_login_at is written in the same unit as the rotation.
        $recorded = $this->accounts->findById(1);
        self::assertNotNull($recorded);
        self::assertSame(self::NOW, $recorded->lastLoginAt);

        // 4. Logout with the stale token is refused; with the fresh one it works.
        $newToken = (string) $body['csrfToken'];
        self::assertSame(403, $this->logout($kernel, $newSessionId, $token)->status);
        self::assertNotNull($this->sessions->find($newSessionId));

        self::assertSame(204, $this->logout($kernel, $newSessionId, $newToken)->status);
        self::assertNull($this->sessions->find($newSessionId), 'logout left the row in MySQL');
    }

    public function testADisabledAccountCannotSignInAgainstMysql(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, false);
        $kernel = $this->bootAgainstMysql();

        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();

        $response = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );

        /** @var array<string, mixed> $body */
        $body = $response->decodedBody();

        // The password is correct. Disabling is what refuses it, and it refuses it
        // with the same envelope a wrong password gets.
        self::assertSame(401, $response->status);
        self::assertSame('INVALID_CREDENTIALS', $body['error']['code']);
        self::assertNull($response->header('Set-Cookie'));
    }

    public function testNoDatabaseCredentialAppearsInAnyResponseOrLog(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();

        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $this->login($kernel, self::cookieValue($anonymous), (string) $anonymousBody['csrfToken'], 'wrong');

        $settings = TestDatabase::settings();
        $log = (string) @file_get_contents($this->root . '/var/log/app.log');

        foreach ([$anonymous->body, $log] as $text) {
            if ($settings->password !== '') {
                self::assertStringNotContainsString($settings->password, $text);
            }
            self::assertStringNotContainsString($settings->dsn, $text);
            self::assertStringNotContainsString(self::PASSWORD, $text);
        }
    }

    // --- helpers -----------------------------------------------------------

    private function email(string $raw): AdminEmail
    {
        return AdminEmail::fromString($raw, TestEnvironment::artifacts());
    }

    private function at(string $offset): string
    {
        return IsoTimestamp::format($this->clock->now()->modify($offset));
    }

    private function availabilityHead(): int
    {
        return $this->availability->revision();
    }

    /**
     * @param list<array<string, mixed>> $rules
     * @return array<string, mixed>
     */
    private function replaceWeekly(array $rules): array
    {
        return $this->bookingApi->adminReplaceWeeklyAvailability([
            'expectedRevision' => $this->availabilityHead(),
            'rules' => $rules,
        ]);
    }

    /**
     * @param array<string, mixed> $mutation
     * @return array<string, mixed>
     */
    private function mutateException(array $mutation): array
    {
        return $this->bookingApi->adminMutateAvailabilityException([
            'expectedRevision' => $this->availabilityHead(),
            ...$mutation,
        ]);
    }

    private function session(?int $accountId, string $idle, string $absolute): Session
    {
        return new Session(
            Session::newId(),
            $accountId,
            Session::newCsrfToken(),
            self::NOW,
            self::NOW,
            $this->at($idle),
            $this->at($absolute),
        );
    }

    /**
     * The real front controller, wired to this MySQL connection.
     *
     * Passing the same `Database` the test uses is what keeps the kernel inside
     * the test's transaction — a second connection would not see the uncommitted
     * account, and rolling back would not undo what the kernel wrote.
     */
    private function bootAgainstMysql(): Kernel
    {
        $configPath = TestEnvironment::writeDeployment($this->root);
        TestEnvironment::writeExportedPage($this->root);

        return Kernel::boot(
            $configPath,
            $this->clock,
            null,
            null,
            new AdminAccountRepository($this->database, $this->clock),
            new PdoSessionStore($this->database, $this->clock),
            null,
            $this->bookingApi,
        );
    }

    private static function cookieValue(Response $response): string
    {
        $cookie = (string) $response->header('Set-Cookie');

        return preg_match('/=([0-9a-f]{64});/', $cookie, $match) === 1 ? $match[1] : '';
    }

    private function login(Kernel $kernel, string $sessionId, string $token, string $password): Response
    {
        return $kernel->handle(new Request(
            'POST',
            '/api/auth/login',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                $this->csrfHeader() => $token,
                'content-type' => 'application/json',
            ],
            (string) json_encode(['email' => self::EMAIL, 'password' => $password]),
        ));
    }

    private function logout(Kernel $kernel, string $sessionId, string $token): Response
    {
        return $kernel->handle(new Request(
            'POST',
            '/api/auth/logout',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                $this->csrfHeader() => $token,
            ],
        ));
    }

    private function createBookingFor(string $serviceKey): \Eszter\Booking\Booking
    {
        return $this->bookings->createConfirmed(
            $serviceKey,
            new \DateTimeImmutable('2026-07-01T08:00:00.000Z'),
            new \DateTimeImmutable('2026-07-01T10:00:00.000Z'),
            'Cliente Exemple',
            'cliente@example.test',
            null,
            null,
            new \DateTimeImmutable('2026-06-13T12:00:00.000Z'),
            $this->bookingContract->currentConsentNoticeId,
        );
    }

    /** @return list<array<string, mixed>> */
    private function notificationRows(int $bookingId): array
    {
        return $this->database->fetchAll(
            'SELECT job_type, status, due_at_utc, last_error_code'
            . ' FROM notification_jobs WHERE booking_id = :booking ORDER BY id',
            ['booking' => $bookingId],
        );
    }

    /**
     * ESZ-139 — the booking's current `updatedAt`, i.e. the
     * optimistic-concurrency token a fresh admin read would hand the editor.
     */
    private function bookingToken(string $reference): string
    {
        $booking = $this->bookings->find($reference);
        self::assertNotNull($booking);

        return $booking->updatedAt;
    }

    /**
     * ESZ-139 — `adminMutate` as a fresh client sends it: with the row's
     * current token read just before the mutation. Tests that assert stale
     * refusals pass an explicit old token instead.
     *
     * @param array<string, mixed> $extra
     * @return array<string, mixed>
     */
    private function adminMutateFresh(string $action, string $reference, array $extra = []): array
    {
        return $this->bookingApi->adminMutate([
            'action' => $action,
            'reference' => $reference,
            'expectedUpdatedAt' => $this->bookingToken($reference),
            ...$extra,
        ]);
    }

    /** @return array<string, mixed> */
    private function publicBookingRequest(string $serviceKey, string $startsAtUtc): array
    {
        return [
            'serviceKey' => $serviceKey,
            'startsAtUtc' => $startsAtUtc,
            'customerName' => 'Cliente Exemple',
            'customerEmail' => 'cliente@example.test',
            'customerPhone' => null,
            'customerNote' => null,
            // ESZ-142: the catalog's current consent notice id — what the
            // shipped frontend displays and therefore sends.
            'consentNoticeId' => $this->bookingContract->currentConsentNoticeId,
            'consentAccepted' => true,
        ];
    }

    /**
     * One weekly rule as the HTTP surface carries it, rather than as a domain
     * object. These tests drive `PdoBookingApi`, so they must send what a request
     * body sends.
     *
     * @return array<string, mixed>
     */
    private function weeklyRulePayload(
        int $weekday,
        string $start,
        string $end,
        ?string $from = null,
        ?string $until = null,
        bool $active = true,
        ?string $fold = null,
    ): array {
        return [
            'weekdayIso' => $weekday,
            'startLocal' => $start,
            'endLocal' => $end,
            'foldUtcOffset' => $fold,
            'validFrom' => $from,
            'validUntil' => $until,
            'isActive' => $active,
        ];
    }

    /** @return list<string> */
    private function localStarts(string $localDate): array
    {
        $availability = $this->bookingApi->availability([
            'serviceKey' => 'brows',
            'fromDate' => $localDate,
            'untilDate' => $localDate,
        ]);

        /** @var list<array<string, mixed>> $slots */
        $slots = $availability['slots'];

        return array_map(static fn (array $slot): string => (string) $slot['localStart'], $slots);
    }

    private function confirmedAt(string $startsAtUtc): \Eszter\Booking\Booking
    {
        $start = new \DateTimeImmutable($startsAtUtc);

        return $this->bookings->createConfirmed(
            'brows',
            $start,
            $start->modify('+30 minutes'),
            'Cliente ' . $start->format('Hi'),
            'cliente@example.test',
            null,
            null,
            new \DateTimeImmutable(self::NOW),
            $this->bookingContract->currentConsentNoticeId,
        );
    }

    private function availabilityWindow(
        string $start,
        string $end,
        ?string $fold = null,
    ): AvailabilityWindow {
        return AvailabilityWindow::create($start, $end, $fold, $this->bookingContract);
    }

    private function weeklyRule(
        int $weekday,
        string $start,
        string $end,
        ?string $from = null,
        ?string $until = null,
        ?string $fold = null,
    ): WeeklyAvailabilityRule {
        return new WeeklyAvailabilityRule(
            0,
            $weekday,
            $this->availabilityWindow($start, $end, $fold),
            $from,
            $until,
            true,
        );
    }

    private function cookieName(): string
    {
        /** @var array<string, mixed> $cookie */
        $cookie = TestEnvironment::artifacts()->authContract()['sessionCookie'];
        /** @var string $name */
        $name = $cookie['name'];

        return $name;
    }

    private function csrfHeader(): string
    {
        /** @var array<string, mixed> $csrf */
        $csrf = TestEnvironment::artifacts()->authContract()['csrf'];
        /** @var string $header */
        $header = $csrf['header'];

        return $header;
    }

    // --- ESZ-144: explicit pagination and exact summary aggregation --------

    /**
     * ISO instant plus a minute offset, as the database form the fixtures
     * store (`Y-m-d H:i:s.v`).
     */
    private function dbStart(string $instant, int $minutes): string
    {
        return (new \DateTimeImmutable($instant))->modify("+{$minutes} minutes")->format('Y-m-d H:i:s.v');
    }

    /**
     * Bulk-inserts raw booking rows, bypassing the slot engine exactly as the
     * ESZ-085 fixture did: the point is a table holding more rows in one valid
     * window than the old 1000-row cap allowed, and the domain rules that stop
     * two appointments overlapping would make that impossible to arrange
     * honestly.
     *
     * @param list<array{start: string, state?: string, reference?: string, name?: string, end?: string}> $rows
     * @return list<string> the references, in insertion order
     */
    private function insertRawBookings(array $rows): array
    {
        $references = [];
        // Global across calls: a test that bulk-inserts twice must not reuse
        // default references (each test instance is fresh, so runs restart).
        static $sequence = -1;
        $stamp = (new \DateTimeImmutable(self::NOW))->format('Y-m-d H:i:s');

        foreach (\array_chunk($rows, 200) as $chunk) {
            $values = [];
            $parameters = [];

            foreach ($chunk as $row) {
                $i = ++$sequence;
                $reference = $row['reference'] ?? 'bk_' . str_pad(dechex($i), 32, '0', STR_PAD_LEFT);
                $start = $row['start'];
                $state = $row['state'] ?? 'confirmed';
                $cancelled = $state === 'cancelled';
                $end = $row['end'] ?? (new \DateTimeImmutable($start, new \DateTimeZone('UTC')))
                    ->modify('+1 minute')
                    ->format('Y-m-d H:i:s');

                $values[] = "(:ref{$i}, 'brows', :state{$i}, :start{$i}, :end{$i}, 'Europe/Paris',"
                    . " :name{$i}, 'cliente@example.test', NULL, NULL, :consent{$i},"
                    . ($cancelled ? ':cancelled' . $i : 'NULL')
                    . ', NULL, :created' . $i . ', :updated' . $i . ', :changed' . $i . ')';

                $parameters["ref{$i}"] = $reference;
                $parameters["state{$i}"] = $state;
                $parameters["start{$i}"] = $start;
                $parameters["end{$i}"] = $end;
                $parameters["name{$i}"] = $row['name'] ?? 'Cliente';
                $parameters["consent{$i}"] = $stamp;
                if ($cancelled) {
                    $parameters["cancelled{$i}"] = $stamp;
                }
                $parameters["created{$i}"] = $stamp;
                $parameters["updated{$i}"] = $stamp;
                $parameters["changed{$i}"] = $stamp;

                $references[] = $reference;
            }

            $this->database->run(
                'INSERT INTO bookings (reference, service_key, state, starts_at_utc, ends_at_utc,'
                . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
                . ' consent_at_utc, cancelled_at_utc, cancellation_reason, created_at, updated_at,'
                . ' state_changed_at) VALUES ' . implode(', ', $values),
                $parameters,
            );
        }

        return $references;
    }

    /** @return list<array<string, mixed>> */
    private function rangeRows(string $fromUtc, string $untilUtc): array
    {
        return $this->database->fetchAll(
            'SELECT reference, state, starts_at_utc FROM bookings'
            . ' WHERE starts_at_utc >= :from AND starts_at_utc < :until'
            . ' ORDER BY starts_at_utc, reference',
            ['from' => $fromUtc, 'until' => $untilUtc],
        );
    }

    /**
     * The old ESZ-085 read, reproduced as SQL: one overlap-predicate scan with
     * a silent `LIMIT slotMaxResults`. The proof datasets below are ordered so
     * this capped read cannot see confirmed rows that a page walk reaches.
     *
     * @return list<string> references the old read would have returned
     */
    private function oldCappedRead(string $fromUtc, string $untilUtc): array
    {
        $rows = $this->database->fetchAll(
            'SELECT reference FROM bookings'
            . ' WHERE starts_at_utc < :until AND ends_at_utc > :from'
            . ' ORDER BY starts_at_utc, reference'
            . ' LIMIT ' . $this->bookingContract->slotMaxResults,
            ['from' => $fromUtc, 'until' => $untilUtc],
        );

        return array_column($rows, 'reference');
    }

    /**
     * A range walk with >1000 rows in one valid admin window, a majority of
     * them cancelled and ordered so the old 1000-row cap would hide every
     * confirmed row. Proves the page walk has no duplicate and no gap — two
     * bookings share the instant that falls exactly on a page boundary — that
     * the whole range is obtainable, and that hasMore comes from a pageSize+1
     * probe rather than from clipping.
     */
    public function testARangeWalkPagesPastTheOldCapWithoutDuplicatesOrGaps(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);

        // 1000 cancelled rows first in start order (2026-07-01 06:00Z +
        // minute), then 200 confirmed rows later the same way, then 5 more so
        // the final page is short. Rows 199 and 200 (1-based) share one start
        // instant: the pageSize boundary falls between two equal-instant rows,
        // which is the case a reference tie-break exists for.
        $rows = [];
        for ($i = 0; $i < 1000; ++$i) {
            $rows[] = [
                'start' => $this->dbStart('2026-07-01T06:00:00Z', $i),
                'state' => 'cancelled',
            ];
        }
        // The equal-instant pair straddling the page 1/page 2 boundary.
        $rows[199] = [
            'start' => $this->dbStart('2026-07-01T06:00:00Z', 199),
            'state' => 'cancelled',
        ];
        $rows[200] = [
            'start' => $this->dbStart('2026-07-01T06:00:00Z', 199),
            'state' => 'cancelled',
        ];
        for ($i = 1000; $i < 1200; ++$i) {
            $rows[] = [
                'start' => $this->dbStart('2026-07-03T06:00:00Z', $i - 1000),
                'state' => 'confirmed',
            ];
        }
        for ($i = 1200; $i < 1205; ++$i) {
            $rows[] = [
                'start' => $this->dbStart('2026-07-05T06:00:00Z', $i - 1200),
                'state' => 'confirmed',
            ];
        }
        $inserted = $this->insertRawBookings($rows);
        $confirmedRefs = \array_slice($inserted, 1000);

        $fromUtc = new \DateTimeImmutable('2026-07-01T00:00:00Z');
        $untilUtc = new \DateTimeImmutable('2026-08-01T00:00:00Z');

        // SQL truth for the whole window, and what the old capped read saw.
        $truth = $this->rangeRows('2026-07-01 00:00:00.000', '2026-08-01 00:00:00.000');
        self::assertCount(1205, $truth);
        $oldCapped = $this->oldCappedRead('2026-07-01 00:00:00.000', '2026-08-01 00:00:00.000');
        self::assertCount(1000, $oldCapped, 'the old read returned its cap, not the range');
        foreach ($confirmedRefs as $reference) {
            self::assertNotContains(
                $reference,
                $oldCapped,
                'the old 1000-row cap hid a confirmed row the range holds',
            );
        }

        // Walk every page exactly as the calendar client does, cursor in hand.
        $pageSize = $this->bookingContract->adminRangePageSize;
        $walked = [];
        $anchorStart = null;
        $anchorReference = null;
        $pages = 0;
        do {
            $page = $this->bookings->pageBetween($fromUtc, $untilUtc, $anchorStart, $anchorReference, $pageSize);
            ++$pages;
            self::assertLessThanOrEqual($pageSize, \count($page['rows']), 'a page exceeded pageSize');

            foreach ($page['rows'] as $booking) {
                $walked[] = $booking->reference;
                // Strictly increasing keys: the tie-break makes equal instants
                // order, so no duplicate and no gap can slip across a boundary.
                if (isset($previous)) {
                    $later = $booking->startsAtUtc > $previous[0]
                        || ($booking->startsAtUtc === $previous[0] && $booking->reference > $previous[1]);
                    self::assertTrue($later, 'the walk went backwards or repeated a key');
                }
                $previous = [$booking->startsAtUtc, $booking->reference];
            }

            self::assertSame(
                \count($page['rows']) === $pageSize && $pages * $pageSize < 1205,
                $page['hasMore'],
                'hasMore disagreed with the pageSize+1 probe on page ' . $pages,
            );
            if ($page['hasMore']) {
                $last = $page['rows'][\count($page['rows']) - 1];
                $anchorStart = $last->startsAtUtc;
                $anchorReference = $last->reference;
            } else {
                $anchorStart = null;
                $anchorReference = null;
            }
        } while ($page['hasMore']);

        // Complete, duplicate-free and in exactly the SQL order.
        self::assertCount(1205, $walked, 'the walk did not reach every row of the range');
        self::assertSame(\array_column($truth, 'reference'), $walked, 'the walk order diverged from SQL order');
        self::assertCount(\count(\array_unique($walked)), $walked, 'the walk duplicated a row across pages');
        self::assertGreaterThan(1, $pages, 'the walk never needed a second page');
        foreach ($confirmedRefs as $reference) {
            self::assertContains($reference, $walked, 'a confirmed row was unreachable by paging');
        }
    }

    /**
     * The same keyset mechanics at page boundaries inside one equal instant,
     * at a small page size, plus the refusal cases: a page size outside the
     * contract bounds and a half-supplied cursor.
     */
    public function testKeysetPaginationSplitsEqualInstantsExactlyOnce(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);

        $rows = [];
        for ($i = 0; $i < 5; ++$i) {
            $rows[] = [
                'start' => '2026-07-01 06:00:00.000',
                'reference' => 'bk_' . str_pad(dechex(1 + $i), 32, '0', STR_PAD_LEFT),
                'name' => 'Cliente ' . ($i + 1),
            ];
        }
        $rows[] = [
            'start' => '2026-07-01 06:15:00.000',
            'reference' => 'bk_' . str_pad(dechex(99), 32, '0', STR_PAD_LEFT),
        ];
        $rows[] = [
            'start' => '2026-07-01 06:15:00.000',
            'reference' => 'bk_' . str_pad(dechex(100), 32, '0', STR_PAD_LEFT),
        ];
        $rows[] = [
            'start' => '2026-07-01 06:30:00.000',
            'reference' => 'bk_' . str_pad(dechex(101), 32, '0', STR_PAD_LEFT),
        ];
        $inserted = $this->insertRawBookings($rows);

        // pageSize 3 puts a boundary between hex-…-99 and hex-…-100, two rows
        // at the same 06:15 instant.
        $pageSize = 3;
        $walked = [];
        $anchor = null;
        do {
            $page = $this->bookings->pageBetween(
                new \DateTimeImmutable('2026-07-01T00:00:00Z'),
                new \DateTimeImmutable('2026-08-01T00:00:00Z'),
                $anchor['start'] ?? null,
                $anchor['reference'] ?? null,
                $pageSize,
            );
            foreach ($page['rows'] as $booking) {
                $walked[] = $booking->reference;
            }
            if ($page['hasMore']) {
                $last = $page['rows'][\count($page['rows']) - 1];
                $anchor = ['start' => $last->startsAtUtc, 'reference' => $last->reference];
            }
        } while ($page['hasMore']);

        self::assertSame($inserted, $walked, 'equal instants were duplicated or skipped across pages');

        try {
            $this->bookings->pageBetween(
                new \DateTimeImmutable('2026-07-01T00:00:00Z'),
                new \DateTimeImmutable('2026-08-01T00:00:00Z'),
                null,
                null,
                $this->bookingContract->adminRangePageSize + 1,
            );
            self::fail('a page size above the contract ceiling was accepted');
        } catch (BookingValidationException $exception) {
            self::assertSame('pageSize', $exception->field);
        }

        try {
            $this->bookings->pageBetween(
                new \DateTimeImmutable('2026-07-01T00:00:00Z'),
                new \DateTimeImmutable('2026-08-01T00:00:00Z'),
                '2026-07-01 06:00:00.000',
                null,
                5,
            );
            self::fail('a half-supplied cursor was accepted');
        } catch (BookingValidationException $exception) {
            self::assertSame('cursor', $exception->field);
        }
    }

    /**
     * The summary counts and the next confirmed instant are exact SQL
     * aggregations over the whole window. Fixture: 1000 cancelled rows today,
     * chronologically first so the old capped read cannot see any confirmed
     * row, plus one confirmed today and 120 confirmed + 3 cancelled upcoming.
     * The old summary derived its counts from that capped list; this one must
     * equal SQL truth, keep cancelled rows out of the entries, bound the
     * upcoming list at the contract ceiling and say it did.
     */
    public function testTheSummaryCountsAreExactWhileCancelledRowsNeverHideConfirmedOnes(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);

        // "Today" is 2026-06-13 Paris (the frozen clock reads 14:00 Paris).
        // 1000 cancelled rows occupy every minute from Paris 00:00 (22:00Z on
        // the 12th) to 16:39, so the confirmed rows that follow are all beyond
        // the old 1000-row cap in start order. Insertion order is cancelled
        // first, then one confirmed today at 17:00 Paris, then 120 confirmed
        // and 3 cancelled upcoming, so the reference slices below are exact.
        $rows = [];
        for ($i = 0; $i < 1000; ++$i) {
            $rows[] = [
                'start' => $this->dbStart('2026-06-12T22:00:00Z', $i),
                'state' => 'cancelled',
            ];
        }
        $rows[] = ['start' => '2026-06-13 15:00:00.000', 'state' => 'confirmed'];
        for ($i = 0; $i < 120; ++$i) {
            $rows[] = [
                'start' => $this->dbStart('2026-06-15T06:00:00Z', $i),
                'state' => 'confirmed',
            ];
        }
        for ($i = 0; $i < 3; ++$i) {
            $rows[] = [
                'start' => $this->dbStart('2026-06-16T06:00:00Z', $i),
                'state' => 'cancelled',
            ];
        }
        $references = $this->insertRawBookings($rows);
        $confirmedToday = $references[1000];
        $upcomingConfirmedRefs = \array_slice($references, 1001, 120);
        $upcomingCancelledRefs = \array_slice($references, 1121, 3);

        // Old-cap evidence: a capped read of this window cannot see a single
        // confirmed row, so the old summary would report no confirmed count,
        // no entry and no next appointment.
        $oldCapped = $this->oldCappedRead('2026-06-12 22:00:00.000', '2026-06-19 22:00:00.000');
        self::assertCount(1000, $oldCapped);
        foreach (array_merge([$confirmedToday], $upcomingConfirmedRefs) as $reference) {
            self::assertNotContains($reference, $oldCapped, 'the old cap hid a confirmed row from the summary');
        }

        $summary = $this->bookingApi->adminSummary(['upcomingDays' => 7]);

        self::assertSame(
            [
                'todayConfirmed' => 1,
                'todayCancelled' => 1000,
                'upcomingConfirmed' => 120,
                'upcomingCancelled' => 3,
            ],
            $summary['counts'],
            'summary counts disagreed with the SQL truth',
        );

        // SQL truth, stated independently of the repository's own query.
        $truth = $this->database->fetchAll(
            'SELECT state, CASE WHEN starts_at_utc < :end_today THEN \'today\' ELSE \'upcoming\' END AS bucket,'
            . ' COUNT(*) AS n FROM bookings'
            . ' WHERE starts_at_utc >= :from AND starts_at_utc < :until GROUP BY state, bucket',
            [
                'from' => '2026-06-12 22:00:00.000',
                'end_today' => $this->bookingTime->databaseUtc(
                    $this->bookingTime->localToUtcWithFoldOffset('2026-06-14 00:00:00', null),
                ),
                'until' => '2026-06-19 22:00:00.000',
            ],
        );
        $truthCounts = [
            'todayConfirmed' => 0,
            'todayCancelled' => 0,
            'upcomingConfirmed' => 0,
            'upcomingCancelled' => 0,
        ];
        foreach ($truth as $row) {
            $key = $row['bucket'] . ucfirst($row['state']);
            $truthCounts[$key] = (int) $row['n'];
        }
        self::assertSame($truthCounts, $summary['counts']);

        // The confirmed entries are listed earliest first and are exactly the
        // confirmed rows SQL returns; cancelled rows never displace them.
        self::assertSame([$confirmedToday], array_column($summary['today'], 'reference'));
        self::assertSame('2026-06-13', $summary['today'][0]['localDate']);
        self::assertSame('17:00', $summary['today'][0]['localStart']);
        self::assertSame(
            \array_slice($upcomingConfirmedRefs, 0, $this->bookingContract->adminSummaryListedEntriesMax),
            array_column($summary['upcoming'], 'reference'),
        );

        // The bounded upcoming collection says it is incomplete; the exact
        // count stays authoritative. The today collection is small and says so.
        self::assertCount($this->bookingContract->adminSummaryListedEntriesMax, $summary['upcoming']);
        self::assertTrue($summary['listings']['todayComplete']);
        self::assertFalse($summary['listings']['upcomingComplete'], 'a truncated list claimed to be complete');
        foreach ($upcomingCancelledRefs as $reference) {
            self::assertNotContains($reference, array_column($summary['upcoming'], 'reference'));
        }

        // Next confirmed is exact over the whole window: the earliest
        // confirmed start at or after now, which the old capped read could
        // not see at all.
        self::assertSame('2026-06-13T15:00:00.000Z', $summary['nextConfirmedStartsAtUtc']);
    }

    /**
     * A cursor is continuation state the server validates: an admin range
     * query refuses one whose instant lies outside the requested window, and
     * reference mode stays an exact lookup.
     */
    public function testARangeQueryValidatesItsCursorAndReferenceModeStaysExact(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $reference = (string) $created['reference'];

        $first = $this->bookingApi->adminQuery([
            'mode' => 'range',
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ]);
        self::assertSame([$reference], array_column($first['bookings'], 'reference'));
        self::assertFalse($first['page']['hasMore']);
        self::assertNull($first['page']['nextCursor']);
        self::assertSame($this->bookingContract->adminRangePageSize, $first['page']['pageSize']);

        $byReference = $this->bookingApi->adminQuery(['mode' => 'reference', 'reference' => $reference]);
        self::assertSame($reference, $byReference['bookings'][0]['reference']);
        self::assertFalse($byReference['page']['hasMore']);

        $outOfWindowCursors = [
            // Before the window.
            ['cursor' => ['startsAtUtc' => '2026-06-01T07:00:00.000Z', 'reference' => $reference]],
            // At or after the window end.
            ['cursor' => ['startsAtUtc' => '2026-06-16T00:00:00.000Z', 'reference' => $reference]],
        ];
        foreach ($outOfWindowCursors as $cursor) {
            try {
                $this->bookingApi->adminQuery([
                    'mode' => 'range',
                    'fromDate' => '2026-06-15',
                    'untilDate' => '2026-06-15',
                    ...$cursor,
                ]);
                self::fail('a cursor outside the requested window was accepted');
            } catch (BookingValidationException $exception) {
                self::assertSame('cursor', $exception->field);
            }
        }
    }

    /**
     * A range read is start-anchored: a booking that began before the window
     * is never part of it, whatever its end, because the calendar pages over
     * the civil day of each start. The summary therefore excludes it too, and
     * its counts cannot be polluted by yesterday's evening appointment.
     */
    public function testARangeReadIsStartAnchoredToTheRequestedWindow(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->confirmedAt('2026-06-14T18:00:00.000Z');

        // A booking that began at 23:00 Paris on the 13th (21:00Z) and runs
        // until 00:30 Paris on the 14th: its interval crosses into the 14th,
        // so an overlap-predicate read of the 14th would list it — but its
        // *start* is on the 13th, so the start-anchored range read of the
        // 14th must not. It is cancelled so it cannot also disturb the
        // summary assertions below — it still proves the point there: it is a
        // today row (its start is today), counted as cancelled, and never
        // listed.
        $this->insertRawBookings([[
            'start' => '2026-06-13 21:00:00.000',
            'end' => '2026-06-13 22:30:00.000',
            'state' => 'cancelled',
        ]]);

        $range = $this->bookingApi->adminQuery([
            'mode' => 'range',
            'fromDate' => '2026-06-14',
            'untilDate' => '2026-06-14',
        ]);
        self::assertCount(1, $range['bookings']);
        self::assertSame('2026-06-14T18:00:00.000Z', $range['bookings'][0]['startsAtUtc']);

        // A booking that began yesterday evening (20:00 Paris on the 12th,
        // 18:00Z) and ran past Paris midnight into the 13th used to reach the
        // summary through its end instant and be mis-bucketed as upcoming.
        // Start-anchored, it is outside the window entirely: it is neither
        // today's nor upcoming's business, and it cannot move the counts.
        $this->insertRawBookings([[
            'start' => '2026-06-12 18:00:00.000',
            'end' => '2026-06-13 02:00:00.000',
            'state' => 'confirmed',
        ]]);

        $summary = $this->bookingApi->adminSummary(['upcomingDays' => 7]);
        self::assertSame(0, $summary['counts']['todayConfirmed']);
        self::assertSame(1, $summary['counts']['todayCancelled']);
        self::assertSame(1, $summary['counts']['upcomingConfirmed']);
        self::assertSame(
            ['2026-06-14T18:00:00.000Z'],
            array_column($summary['upcoming'], 'startsAtUtc'),
        );
        self::assertSame('2026-06-14T18:00:00.000Z', $summary['nextConfirmedStartsAtUtc']);
    }

    // --- ESZ-134: login is fail-closed after session rotation -----------------

    /**
     * The success half of the ESZ-134 acceptance criterion, against the real
     * production wiring: rotation, last_login_at and the required rehash are one
     * committed transition, and the authenticated session is published only
     * after that commit.
     */
    public function testARequiredRehashIsCommittedWithTheSessionWhenLoginSucceeds(): void
    {
        $this->leaveTheWrapperTransaction();
        $legacy = $this->insertLegacyHashAccount(self::PASSWORD);

        // Fixture guard: if PASSWORD_DEFAULT ever stops considering a cost-10
        // bcrypt hash outdated, the rehash branch this proof exists for is dead
        // and this test must say so instead of silently passing.
        self::assertTrue(AdminAccountRepository::needsRehash($legacy));

        $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::REHASH_NOW));
        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $accepted = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );
        /** @var array<string, mixed> $body */
        $body = $accepted->decodedBody();

        self::assertSame(200, $accepted->status);
        self::assertTrue($body['authenticated']);
        self::assertIsString($accepted->header('Set-Cookie'));

        // Exactly one authenticated session row was committed.
        $sessions = $this->database->fetchAll(
            'SELECT id, account_id FROM admin_sessions WHERE account_id IS NOT NULL',
        );
        self::assertCount(1, $sessions);
        self::assertSame(1, (int) $sessions[0]['account_id']);

        // The account half of the transition committed too: the hash was
        // upgraded and the login was recorded under the kernel's clock.
        $account = $this->database->fetchOne(
            'SELECT password_hash, last_login_at FROM admin_accounts WHERE email = :email',
            ['email' => self::EMAIL],
        );
        self::assertIsArray($account);
        self::assertSame(self::REHASH_NOW, $account['last_login_at']);
        self::assertNotSame($legacy, $account['password_hash']);
        self::assertFalse(AdminAccountRepository::needsRehash($account['password_hash']));
        self::assertTrue(password_verify(self::PASSWORD, $account['password_hash']));
    }

    /**
     * ESZ-134, recordLogin path, real production wiring: a failure *after* the
     * rotation must roll back the authenticated session row and the login
     * record, and the error response must publish no cookie. The failure is a
     * real MySQL SIGNAL raised by a trigger the moment recordLogin writes the
     * kernel's clock value into last_login_at — no mock stands in for SQL.
     */
    public function testARecordLoginFailureAfterRotationRollsBackSessionAndLoginRecord(): void
    {
        $this->leaveTheWrapperTransaction();
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $this->installRecordLoginFailureTrigger();

        try {
            $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::FAILED_LOGIN_NOW));
            $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
            /** @var array<string, mixed> $anonymousBody */
            $anonymousBody = $anonymous->decodedBody();
            $sessionId = self::cookieValue($anonymous);

            self::assertSame(1, (int) ($this->database->fetchOne(
                'SELECT COUNT(*) AS n FROM admin_sessions',
            )['n'] ?? 0), 'the anonymous session is not alone in admin_sessions');

            $response = $this->login(
                $kernel,
                $sessionId,
                (string) $anonymousBody['csrfToken'],
                self::PASSWORD,
            );
            /** @var array<string, mixed> $body */
            $body = $response->decodedBody();

            // An error response, never a false success, and no cookie on it.
            self::assertSame(500, $response->status);
            self::assertSame('INTERNAL_ERROR', $body['error']['code']);
            self::assertNull($response->header('Set-Cookie'), 'the 500 published the rotated session cookie');
            self::assertStringNotContainsString($sessionId, $response->body);
            self::assertStringNotContainsString(self::PASSWORD, $response->body);

            // No authenticated session row survived the rollback, and the
            // pre-login anonymous row is back under its original id.
            self::assertSame([], $this->database->fetchAll(
                'SELECT id FROM admin_sessions WHERE account_id IS NOT NULL',
            ));
            $rows = $this->database->fetchAll('SELECT id, account_id FROM admin_sessions');
            self::assertCount(1, $rows);
            self::assertSame($sessionId, $rows[0]['id']);
            self::assertNull($rows[0]['account_id']);

            // The account records no login and no hash change.
            $account = $this->database->fetchOne(
                'SELECT password_hash, last_login_at FROM admin_accounts WHERE email = :email',
                ['email' => self::EMAIL],
            );
            self::assertIsArray($account);
            self::assertNull($account['last_login_at']);
            self::assertTrue(password_verify(self::PASSWORD, $account['password_hash']));

            // The restored anonymous cookie keeps working on the same kernel.
            $replay = $kernel->handle(new Request(
                'GET',
                '/api/auth/session',
                ['cookie' => $this->cookieName() . '=' . $sessionId],
            ));
            /** @var array<string, mixed> $replayBody */
            $replayBody = $replay->decodedBody();
            self::assertSame(200, $replay->status);
            self::assertFalse($replayBody['authenticated']);
            self::assertSame((string) $anonymousBody['csrfToken'], $replayBody['csrfToken']);
        } finally {
            $this->removeRecordLoginFailureTrigger();
        }
    }

    /**
     * ESZ-134, required-rehash path, real production wiring: an account whose
     * hash PASSWORD_DEFAULT considers outdated makes the login rehash inside the
     * same transition, and a failure there rolls the session, the login record
     * and the hash change back together.
     */
    public function testARequiredRehashFailureAfterRotationRollsBackSessionLoginAndHash(): void
    {
        $this->leaveTheWrapperTransaction();
        $legacy = $this->insertLegacyHashAccount(self::PASSWORD);
        $this->installRehashFailureTrigger();

        try {
            $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::REHASH_NOW));
            $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
            /** @var array<string, mixed> $anonymousBody */
            $anonymousBody = $anonymous->decodedBody();
            $sessionId = self::cookieValue($anonymous);

            $response = $this->login(
                $kernel,
                $sessionId,
                (string) $anonymousBody['csrfToken'],
                self::PASSWORD,
            );
            /** @var array<string, mixed> $body */
            $body = $response->decodedBody();

            self::assertSame(500, $response->status);
            self::assertSame('INTERNAL_ERROR', $body['error']['code']);
            self::assertNull($response->header('Set-Cookie'), 'the 500 published the rotated session cookie');

            // The rollback undid the rotation...
            self::assertSame([], $this->database->fetchAll(
                'SELECT id FROM admin_sessions WHERE account_id IS NOT NULL',
            ));
            $rows = $this->database->fetchAll('SELECT id, account_id FROM admin_sessions');
            self::assertCount(1, $rows);
            self::assertSame($sessionId, $rows[0]['id']);
            self::assertNull($rows[0]['account_id']);

            // ...and undid the account half of the transition: the legacy hash
            // is still in place, the upgrade was not committed, and the login
            // was not recorded.
            $account = $this->database->fetchOne(
                'SELECT password_hash, last_login_at FROM admin_accounts WHERE email = :email',
                ['email' => self::EMAIL],
            );
            self::assertIsArray($account);
            self::assertSame($legacy, $account['password_hash']);
            self::assertTrue(AdminAccountRepository::needsRehash($account['password_hash']));
            self::assertNull($account['last_login_at']);

            // The restored anonymous cookie still works on the same kernel.
            $replay = $kernel->handle(new Request(
                'GET',
                '/api/auth/session',
                ['cookie' => $this->cookieName() . '=' . $sessionId],
            ));
            /** @var array<string, mixed> $replayBody */
            $replayBody = $replay->decodedBody();
            self::assertSame(200, $replay->status);
            self::assertFalse($replayBody['authenticated']);
        } finally {
            $this->removeRehashFailureTrigger();
        }
    }

    // --- ESZ-101: password-rotation revocation and honest logout ------------

    /**
     * ESZ-101, proofs 1 and 2: an explicit password change on an existing
     * account revokes every live session of *that* account and no other. The
     * rotation runs through the real operator CLI against this MySQL: two
     * sessions for the account are both gone afterwards, the old password
     * fails and the new one succeeds, and another account's sessions survive.
     */
    public function testEs101PasswordRotationRevokesEveryLiveSessionAndNoOthers(): void
    {
        $this->leaveTheWrapperTransaction();

        $first = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];
        $second = $this->accounts->provision($this->email(self::SECOND_EMAIL), self::SECOND_PASSWORD, true)['account'];

        // Two live sessions for the rotated account, one for the neighbour —
        // each the shape an earlier login leaves behind.
        $firstSession = $this->session($first->id, '+1 hour', '+12 hours');
        $secondSession = $this->session($first->id, '+1 hour', '+12 hours');
        $neighbourSession = $this->session($second->id, '+1 hour', '+12 hours');
        $this->sessions->save($firstSession);
        $this->sessions->save($secondSession);
        $this->sessions->save($neighbourSession);
        $rotatedA = $firstSession->id;
        $rotatedB = $secondSession->id;
        $neighbour = $neighbourSession->id;

        $config = $this->provisionCliConfig();
        [$exit, $stdout, $stderr] = $this->runProvisionAdmin($config, self::EMAIL, self::ROTATED_PASSWORD);

        self::assertSame(0, $exit, $stderr);
        self::assertSame('', $stderr);
        self::assertStringContainsString('Updated ' . self::EMAIL, $stdout);
        self::assertStringContainsString('password set', $stdout);
        self::assertStringContainsString('Signed out of 2 existing session(s).', $stdout);

        // Counts and statuses only on the wire: no password, hash or session id.
        foreach ([self::PASSWORD, self::ROTATED_PASSWORD, $rotatedA, $rotatedB, $neighbour] as $secret) {
            self::assertStringNotContainsString($secret, $stdout . $stderr);
        }

        // Both sessions of the rotated account are gone from MySQL...
        self::assertSame(0, $this->sessionCountFor($first->id));
        // ...and the neighbour account's session survived untouched.
        self::assertSame(1, $this->sessionCountFor($second->id));
        self::assertNotNull($this->sessions->find($neighbour));

        // The stored credential is the new one: the old password fails against
        // the production wiring, the new one succeeds.
        $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::NOW));
        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $sessionId = self::cookieValue($anonymous);
        $token = (string) $anonymousBody['csrfToken'];

        $old = $this->login($kernel, $sessionId, $token, self::PASSWORD);
        self::assertSame(401, $old->status, 'the old password still signs in after the rotation');

        $accepted = $this->login($kernel, $sessionId, $token, self::ROTATED_PASSWORD);
        /** @var array<string, mixed> $acceptedBody */
        $acceptedBody = $accepted->decodedBody();
        self::assertSame(200, $accepted->status);
        self::assertTrue($acceptedBody['authenticated']);
    }

    /**
     * ESZ-101, proof 3: hash update and session revocation are one MySQL
     * transaction. A forced revocation failure (a real trigger SIGNAL on the
     * session delete) rolls the new hash back with it, and the retry after the
     * cause is removed converges — sessions revoked, new password live.
     */
    public function testEs101ARotationWhoseSessionRevocationFailsIsAtomic(): void
    {
        $this->leaveTheWrapperTransaction();

        $account = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];
        $sessionOne = $this->session($account->id, '+1 hour', '+12 hours');
        $sessionTwo = $this->session($account->id, '+1 hour', '+12 hours');
        $this->sessions->save($sessionOne);
        $this->sessions->save($sessionTwo);
        $originalHash = (string) $this->database->fetchOne(
            'SELECT password_hash FROM admin_accounts WHERE id = :id',
            ['id' => $account->id],
        )['password_hash'];

        $this->installSessionDeleteFailureTrigger();

        try {
            $config = $this->provisionCliConfig();
            [$exit, $stdout, $stderr] = $this->runProvisionAdmin($config, self::EMAIL, self::ROTATED_PASSWORD);

            // CLI failure, not a silent success, and no trace of the new secret.
            self::assertNotSame(0, $exit);
            self::assertNotSame('', $stderr);
            self::assertStringNotContainsString('password set', $stdout);
            self::assertStringNotContainsString(self::ROTATED_PASSWORD, $stdout . $stderr);
            self::assertStringNotContainsString(self::PASSWORD, $stdout . $stderr);

            // Atomicity: the account keeps its old hash and every old session.
            $accountRow = $this->database->fetchOne(
                'SELECT password_hash FROM admin_accounts WHERE id = :id',
                ['id' => $account->id],
            );
            self::assertIsArray($accountRow);
            self::assertSame($originalHash, $accountRow['password_hash']);
            self::assertTrue(password_verify(self::PASSWORD, $accountRow['password_hash']));
            self::assertSame(2, $this->sessionCountFor($account->id));
            self::assertNotNull($this->sessions->find($sessionOne->id));
            self::assertNotNull($this->sessions->find($sessionTwo->id));
        } finally {
            $this->removeSessionDeleteFailureTrigger();
        }

        // The same rotation, once the cause is gone, commits: sessions revoked,
        // new password live, operator told the count.
        [$exit, $stdout, $stderr] = $this->runProvisionAdmin(
            $this->provisionCliConfig(),
            self::EMAIL,
            self::ROTATED_PASSWORD,
        );
        self::assertSame(0, $exit, $stderr);
        self::assertStringContainsString('Signed out of 2 existing session(s).', $stdout);
        self::assertSame(0, $this->sessionCountFor($account->id));

        $accountRow = $this->database->fetchOne(
            'SELECT password_hash FROM admin_accounts WHERE id = :id',
            ['id' => $account->id],
        );
        self::assertIsArray($accountRow);
        self::assertNotSame($originalHash, $accountRow['password_hash']);
        self::assertFalse(password_verify(self::PASSWORD, $accountRow['password_hash']));
        self::assertTrue(password_verify(self::ROTATED_PASSWORD, $accountRow['password_hash']));
    }

    /**
     * ESZ-101, proof 4: the automatic login-time rehash is maintenance, not a
     * credential rotation. It upgrades the stored hash and revokes nothing —
     * neither the session the login just rotated onto nor an older live
     * session of the same account.
     */
    public function testEs101ALoginTimeRehashIsMaintenanceAndRevokesNothing(): void
    {
        $this->leaveTheWrapperTransaction();

        $legacy = $this->insertLegacyHashAccount(self::PASSWORD);
        self::assertTrue(AdminAccountRepository::needsRehash($legacy));
        $accountId = (int) $this->database->fetchOne(
            'SELECT id FROM admin_accounts WHERE email = :email',
            ['email' => self::EMAIL],
        )['id'];

        // A session an earlier login (under the then-current hash) left behind,
        // still live under the login clock this test boots its kernel with.
        $rehashClock = new FrozenClock(self::REHASH_NOW);
        $older = new Session(
            Session::newId(),
            $accountId,
            Session::newCsrfToken(),
            IsoTimestamp::format($rehashClock->now()),
            IsoTimestamp::format($rehashClock->now()),
            IsoTimestamp::format($rehashClock->now()->modify('+1 hour')),
            IsoTimestamp::format($rehashClock->now()->modify('+12 hours')),
        );
        $this->sessions->save($older);

        $kernel = $this->bootProductionKernel($this->root, $rehashClock);
        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $accepted = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );
        /** @var array<string, mixed> $body */
        $body = $accepted->decodedBody();

        self::assertSame(200, $accepted->status);
        self::assertTrue($body['authenticated']);
        $rotatedId = self::cookieValue($accepted);

        // The hash was upgraded as part of the login transition.
        $account = $this->database->fetchOne(
            'SELECT password_hash FROM admin_accounts WHERE email = :email',
            ['email' => self::EMAIL],
        );
        self::assertIsArray($account);
        self::assertNotSame($legacy, $account['password_hash']);
        self::assertFalse(AdminAccountRepository::needsRehash($account['password_hash']));
        self::assertTrue(password_verify(self::PASSWORD, $account['password_hash']));

        // Maintenance revoked nothing: both session rows survive — the one the
        // login just rotated onto and the one that predates the upgrade.
        $rows = $this->database->fetchAll(
            'SELECT id FROM admin_sessions WHERE account_id = :account_id',
            ['account_id' => $accountId],
        );
        self::assertCount(2, $rows);
        $surviving = array_column($rows, 'id');
        self::assertContains($rotatedId, $surviving);
        self::assertContains($older->id, $surviving);

        // Both still authorise: the rehash did not kill the session it just
        // authenticated, and did not sweep the older one either.
        foreach ([$rotatedId, $older->id] as $id) {
            $probe = $kernel->handle(new Request(
                'GET',
                '/api/auth/session',
                ['cookie' => $this->cookieName() . '=' . $id],
            ));
            /** @var array<string, mixed> $probeBody */
            $probeBody = $probe->decodedBody();
            self::assertTrue($probeBody['authenticated'], "session {$id} was revoked by the rehash");
        }
    }

    /**
     * ESZ-101, proof 5: a successful logout destroys the server-side row before
     * the cookie is expired — the 204 carries the expired cookie and the old id
     * can no longer authorise anything.
     */
    public function testEs101LogoutDestroysTheRowBeforeTheCookieExpires(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();

        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $accepted = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );
        $sessionId = self::cookieValue($accepted);
        /** @var array<string, mixed> $acceptedBody */
        $acceptedBody = $accepted->decodedBody();
        self::assertNotNull($this->sessions->find($sessionId));

        $loggedOut = $this->logout($kernel, $sessionId, (string) $acceptedBody['csrfToken']);

        self::assertSame(204, $loggedOut->status);
        // The row is gone from MySQL — deletion is the mechanism.
        self::assertNull($this->sessions->find($sessionId), 'logout left the session row in MySQL');

        // The cookie on the same response is the expiry, not a fresh session.
        $cookie = (string) $loggedOut->header('Set-Cookie');
        self::assertStringContainsString('Max-Age=0', $cookie);
        self::assertStringContainsString('Expires=Thu, 01 Jan 1970 00:00:00 GMT', $cookie);
        self::assertStringNotContainsString($sessionId, $cookie);

        // Replaying the exact pre-logout cookie is anonymous...
        $replayed = $kernel->handle(new Request(
            'GET',
            '/api/auth/session',
            ['cookie' => $this->cookieName() . '=' . $sessionId],
        ));
        /** @var array<string, mixed> $replayedBody */
        $replayedBody = $replayed->decodedBody();
        self::assertFalse($replayedBody['authenticated']);

        // ...and the old id cannot authorise a privileged route.
        $privileged = $kernel->handle(new Request(
            'GET',
            '/api/admin/content/draft',
            ['cookie' => $this->cookieName() . '=' . $sessionId],
        ));
        self::assertSame(401, $privileged->status);
    }

    /**
     * ESZ-101, proof 6: a logout whose server-side record deletion fails is a
     * failure, honestly reported — 500, no successful cookie clear, no
     * logout-success log — and the session it failed to destroy keeps
     * authorising until a retry succeeds.
     */
    public function testEs101ALogoutWhoseStoreDeletionFailsAnswersFiveHundred(): void
    {
        $this->leaveTheWrapperTransaction();
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);

        // Booted at debug level so the proof can assert on log *presence* (the
        // success line) as well as absence; the default error level only lets
        // it assert absence.
        $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::NOW), 'debug');
        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $accepted = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );
        $sessionId = self::cookieValue($accepted);
        /** @var array<string, mixed> $acceptedBody */
        $acceptedBody = $accepted->decodedBody();

        $this->installSessionDeleteFailureTrigger();

        try {
            $response = $this->logout($kernel, $sessionId, (string) $acceptedBody['csrfToken']);
            /** @var array<string, mixed> $body */
            $body = $response->decodedBody();

            // An error status, never a 204 — and no successful cookie clear.
            self::assertSame(500, $response->status);
            self::assertSame('INTERNAL_ERROR', $body['error']['code']);
            self::assertNull($response->header('Set-Cookie'), 'the failed logout cleared the session cookie');

            // No logout-success log line: the record was not deleted.
            $log = (string) @file_get_contents($this->root . '/var/log/app.log');
            self::assertStringNotContainsString('Logout completed', $log);

            // The session the logout failed to destroy still authorises.
            self::assertNotNull($this->sessions->find($sessionId), 'the failed logout deleted the row');
            $probe = $kernel->handle(new Request(
                'GET',
                '/api/auth/session',
                ['cookie' => $this->cookieName() . '=' . $sessionId],
            ));
            /** @var array<string, mixed> $probeBody */
            $probeBody = $probe->decodedBody();
            self::assertTrue($probeBody['authenticated'], 'the session stopped authorising after a failed logout');
        } finally {
            $this->removeSessionDeleteFailureTrigger();
        }

        // Once the store recovers, the retry of the same logout succeeds: the
        // failure consumed nothing, and the success is now logged.
        $retry = $this->logout($kernel, $sessionId, (string) $acceptedBody['csrfToken']);
        self::assertSame(204, $retry->status);
        self::assertNull($this->sessions->find($sessionId));
        self::assertStringContainsString('Max-Age=0', (string) $retry->header('Set-Cookie'));
        $log = (string) @file_get_contents($this->root . '/var/log/app.log');
        self::assertStringContainsString('Logout completed', $log);
    }

    // --- ESZ-130: the anonymous session bootstrap is bounded -----------------

    /**
     * ESZ-130, proof 1: repeated no-cookie reads of `GET /api/auth/session`
     * from one address admit exactly the burst (10), then refuse with the
     * frozen 429 — and every refused call adds zero `admin_sessions` rows and
     * sets no cookie. The refusals also carry `Retry-After` in whole seconds
     * and a body that names no session, no token and no address.
     */
    public function testEs130RepeatedNoCookieSessionReadsHitTheBurstThenRefuse(): void
    {
        $this->leaveTheWrapperTransaction();
        $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::NOW));

        $ids = [];
        for ($i = 0; $i < 10; ++$i) {
            $response = $kernel->handle($this->esz130Read());
            self::assertSame(200, $response->status, 'admitted no-cookie read #' . ($i + 1));
            self::assertNotNull($response->header('Set-Cookie'), 'an admitted bootstrap must set the cookie');
            $ids[] = self::cookieValue($response);
        }

        self::assertSame(10, $this->esz130SessionCount());

        $refused = $kernel->handle($this->esz130Read());
        /** @var array<string, mixed> $body */
        $body = $refused->decodedBody();

        self::assertSame(429, $refused->status);
        self::assertSame('RATE_LIMITED', $body['error']['code']);
        self::assertSame('120', $refused->header('Retry-After'));
        self::assertNull($refused->header('Set-Cookie'), 'a refused bootstrap set a cookie');
        self::assertSame(10, $this->esz130SessionCount(), 'a refused bootstrap created a session row');

        // The refusal leaks nothing: no session id, no CSRF token, no address.
        self::assertStringNotContainsString(self::ESZ130_ADDRESS, (string) $refused->body);
        foreach ($ids as $id) {
            self::assertStringNotContainsString($id, (string) $refused->body);
        }
    }

    /**
     * ESZ-130: "no live session" means exactly what {@see SessionManager::load()}
     * says — an invented id, a malformed cookie value and an expired id are all
     * charged like the absence of a cookie, and none of the supplied ids is ever
     * adopted (the session-fixation floor).
     */
    public function testEs130InventedMalformedAndExpiredCookiesAreEachANewBootstrap(): void
    {
        $this->leaveTheWrapperTransaction();
        $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::NOW));

        $invented = str_repeat('ab', 32);
        $response = $kernel->handle($this->esz130Read($invented));
        self::assertSame(200, $response->status);
        self::assertNotSame($invented, self::cookieValue($response), 'an invented id was adopted');
        self::assertSame(1, $this->esz130SessionCount());

        // A malformed cookie value never reaches the store: SessionCookie::read()
        // rejects the shape and the request is a plain anonymous bootstrap.
        $malformed = $kernel->handle($this->esz130Read("' OR 1=1 --"));
        self::assertSame(200, $malformed->status);
        self::assertSame(2, $this->esz130SessionCount());

        // An expired id: the row is dead, so the read is a new bootstrap; the
        // sweep that runs on admission removes the expired row before the new
        // one is created, so the table grows by zero and the old id is gone.
        $expired = $this->session(null, '-1 second', '+12 hours');
        $this->sessions->save($expired);
        self::assertSame(3, $this->esz130SessionCount());

        $response = $kernel->handle($this->esz130Read($expired->id));
        self::assertSame(200, $response->status);
        self::assertNotSame($expired->id, self::cookieValue($response), 'an expired id was adopted');
        self::assertSame(3, $this->esz130SessionCount(), 'the expired row was not swept or the new one not created');
        self::assertNull($this->sessions->find($expired->id), 'the expired row survived the bootstrap sweep');
    }

    /**
     * ESZ-130, proof 2: retaining the cookie reuses and touches one anonymous
     * session, repeated reads with it spend none of the new-bootstrap allowance
     * (14 requests, two charges — a charged-read implementation would have
     * refused the second bootstrap), and a live-session read keeps answering
     * 200 even while the same address's bootstrap budget is empty.
     */
    public function testEs130RetainingTheCookieReusesOneSessionAndSpendsNoAllowance(): void
    {
        $this->leaveTheWrapperTransaction();
        $clock = new MovableClock(self::NOW);
        $kernel = $this->bootProductionKernel($this->root, $clock);

        $first = $kernel->handle($this->esz130Read());
        self::assertSame(200, $first->status);
        $sessionId = self::cookieValue($first);
        /** @var array<string, mixed> $firstBody */
        $firstBody = $first->decodedBody();
        $token = (string) $firstBody['csrfToken'];
        self::assertSame(1, $this->esz130SessionCount());

        $clock->advanceMinutes(2);

        for ($i = 0; $i < 12; ++$i) {
            $reuse = $kernel->handle($this->esz130Read($sessionId));
            self::assertSame(200, $reuse->status, 'live-session read #' . ($i + 1));
            self::assertNull($reuse->header('Set-Cookie'), 'a live-session read re-sent the cookie');
            /** @var array<string, mixed> $reuseBody */
            $reuseBody = $reuse->decodedBody();
            self::assertSame($token, $reuseBody['csrfToken'], 'the reuse minted a fresh token');
        }

        // One row, touched (its idle deadline slid) — never duplicated.
        self::assertSame(1, $this->esz130SessionCount());
        $row = $this->database->fetchOne(
            'SELECT last_seen_at, expires_at FROM admin_sessions WHERE id = :id',
            ['id' => $sessionId],
        );
        self::assertIsArray($row);
        self::assertSame('2026-06-13T12:02:00.000Z', $row['last_seen_at'], 'the retained session was not touched');

        // A second no-cookie read is still admitted after twelve cookie reads:
        // the cookie reads were never charged.
        $second = $kernel->handle($this->esz130Read());
        self::assertSame(200, $second->status);
        self::assertSame(2, $this->esz130SessionCount());

        // Exhaust the remaining bootstrap allowance. Two minutes elapsed
        // between the first charge and the rest, which restores exactly one
        // emission interval of allowance: eleven charges fit between T0 and
        // T0+2m (the burst of ten plus the one unit the elapsed interval
        // refilled), and the twelfth is refused.
        for ($i = 0; $i < 9; ++$i) {
            self::assertSame(200, $kernel->handle($this->esz130Read())->status);
        }
        self::assertSame(11, $this->esz130SessionCount());
        self::assertSame(429, $kernel->handle($this->esz130Read())->status);
        self::assertSame(11, $this->esz130SessionCount(), 'the refused read created a row');

        // ...and the retained cookie still reads fine: live sessions are never
        // charged, so an empty bootstrap budget cannot lock a real browser out.
        $live = $kernel->handle($this->esz130Read($sessionId));
        self::assertSame(200, $live->status);
        self::assertSame(11, $this->esz130SessionCount());
    }

    /**
     * ESZ-130, proof 5: the session sweep runs through the real bootstrap
     * wiring, removes idle-expired and absolute-expired rows in bounded
     * batches, leaves every live row alone, and repeated passes converge to
     * zero changes.
     */
    public function testEs130TheBootstrapSweepIsBoundedAndConverges(): void
    {
        $this->leaveTheWrapperTransaction();

        $live = [];
        for ($i = 0; $i < 3; ++$i) {
            $live[] = $this->session(null, '+1 hour', '+12 hours');
            $this->sessions->save($live[$i]);
        }
        $this->insertDeadSessions(450, 'idle');
        $this->insertDeadSessions(450, 'absolute');
        self::assertSame(903, $this->esz130SessionCount());

        $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::NOW));

        // One pass per deadline removes at most 200 rows; three passes drain
        // the 900 dead rows (400 + 400 + 100), a fourth changes nothing.
        $expected = [400, 400, 100, 0];
        foreach ($expected as $pass => $deleted) {
            $before = $this->esz130DeadCount();
            $response = $kernel->handle($this->esz130Read());
            self::assertSame(200, $response->status, 'sweep pass #' . ($pass + 1));
            $after = $this->esz130DeadCount();
            self::assertSame($deleted, $before - $after, 'sweep pass #' . ($pass + 1) . ' deleted the wrong number');
        }

        self::assertSame(0, $this->esz130DeadCount());
        self::assertSame(7, $this->esz130SessionCount(), 'the sweep removed or duplicated a live row');

        foreach ($live as $session) {
            self::assertNotNull($this->sessions->find($session->id), 'a live seeded session was swept');
        }
    }

    /**
     * ESZ-130: when the sweep itself fails — a real MySQL trigger SIGNAL on the
     * DELETE — the request fails through the existing opaque error path and no
     * anonymous session row, token or cookie is created. Once the cause is
     * removed the same request succeeds and the sweep completes.
     */
    public function testEs130AFailedSweepCreatesNoRowAndAnswersOpaquely(): void
    {
        $this->leaveTheWrapperTransaction();

        $expired = $this->session(null, '-1 second', '+12 hours');
        $this->sessions->save($expired);
        $this->installEs130SweepFailureTrigger();

        try {
            $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::NOW), 'debug');
            $response = $kernel->handle($this->esz130Read());
            /** @var array<string, mixed> $body */
            $body = $response->decodedBody();

            self::assertSame(500, $response->status);
            self::assertSame('INTERNAL_ERROR', $body['error']['code']);
            self::assertNull($response->header('Set-Cookie'), 'the failed sweep published a cookie');
            self::assertSame(1, $this->esz130SessionCount(), 'the failed sweep still created an anonymous row');
            self::assertStringNotContainsString($expired->id, (string) $response->body);
            self::assertStringNotContainsString(self::ESZ130_ADDRESS, (string) $response->body);
        } finally {
            $this->removeEs130SweepFailureTrigger();
        }

        // Once the store recovers, the very next read sweeps the expired row
        // and creates exactly one anonymous session in its place.
        $retry = $kernel->handle($this->esz130Read());
        self::assertSame(200, $retry->status);
        self::assertSame(1, $this->esz130SessionCount());
        self::assertNull($this->sessions->find($expired->id));
        $remaining = $this->database->fetchOne('SELECT id FROM admin_sessions');
        self::assertIsArray($remaining);
        self::assertSame(self::cookieValue($retry), $remaining['id']);
    }

    /**
     * ESZ-130, proof 4: the anonymous cookie and CSRF token an admitted
     * bootstrap issues still log in through the real production wiring; a
     * cookie paired with another session's token is refused; and a live
     * authenticated read is never charged.
     */
    public function testEs130AnAdmittedBootstrapCookieAndTokenStillLogInAndDoNotCrossPair(): void
    {
        $this->leaveTheWrapperTransaction();
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);

        $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::NOW));

        $first = $kernel->handle($this->esz130Read());
        $firstId = self::cookieValue($first);
        /** @var array<string, mixed> $firstBody */
        $firstBody = $first->decodedBody();
        $firstToken = (string) $firstBody['csrfToken'];

        $second = $kernel->handle($this->esz130Read());
        $secondId = self::cookieValue($second);
        /** @var array<string, mixed> $secondBody */
        $secondBody = $second->decodedBody();
        $secondToken = (string) $secondBody['csrfToken'];

        // Cross-paired cookie and token: 403 on both pairings, rows untouched.
        foreach ([[$firstId, $secondToken], [$secondId, $firstToken]] as [$id, $token]) {
            $refused = $this->login($kernel, $id, $token, self::PASSWORD);
            self::assertSame(403, $refused->status, 'a cross-paired token logged in');
        }
        self::assertSame(2, $this->esz130SessionCount());

        // The correct pairing logs in and rotates onto a fresh session id.
        $accepted = $this->login($kernel, $firstId, $firstToken, self::PASSWORD);
        /** @var array<string, mixed> $acceptedBody */
        $acceptedBody = $accepted->decodedBody();
        self::assertSame(200, $accepted->status);
        self::assertTrue($acceptedBody['authenticated']);
        self::assertSame(self::EMAIL, $acceptedBody['account']['email']);
        $rotated = self::cookieValue($accepted);
        self::assertNotSame($firstId, $rotated);

        // The authenticated session reads fine afterwards — a live-session read,
        // uncharged even though the address has already spent two allowances.
        $live = $kernel->handle($this->esz130Read($rotated));
        self::assertSame(200, $live->status);
        /** @var array<string, mixed> $liveBody */
        $liveBody = $live->decodedBody();
        self::assertTrue($liveBody['authenticated']);
    }

    /**
     * ESZ-130, proof 6: the limiter's storage holds no raw address for the
     * bootstrap bucket, and the application log exposes no session id, no CSRF
     * token and no address — even at debug level with refusals logged.
     */
    public function testEs130TheBootstrapLeavesNoAddressOrSessionSecretInLimiterOrLogs(): void
    {
        $this->leaveTheWrapperTransaction();
        $kernel = $this->bootProductionKernel($this->root, new FrozenClock(self::NOW), 'debug');

        $ids = [];
        $tokens = [];
        for ($i = 0; $i < 10; ++$i) {
            $response = $kernel->handle($this->esz130Read());
            self::assertSame(200, $response->status);
            $ids[] = self::cookieValue($response);
            /** @var array<string, mixed> $body */
            $body = $response->decodedBody();
            $tokens[] = (string) $body['csrfToken'];
            self::assertStringNotContainsString(
                self::cookieValue($response),
                (string) $response->body,
                'a 200 body leaked the session id',
            );
        }
        self::assertSame(429, $kernel->handle($this->esz130Read())->status);

        $rows = $this->database->fetchAll('SELECT * FROM rate_limit_buckets');
        self::assertNotEmpty($rows);
        $dump = (string) json_encode($rows, JSON_PARTIAL_OUTPUT_ON_ERROR);
        self::assertStringNotContainsString(self::ESZ130_ADDRESS, $dump);
        self::assertStringNotContainsString('editor@example.test', $dump);
        foreach ($rows as $row) {
            self::assertSame(32, \strlen((string) $row['bucket_key']), 'the bootstrap key is not a raw sha256');
            self::assertSame(
                RateLimitPolicy::SCOPE_SESSION_BOOTSTRAP_ADDRESS,
                $row['scope'],
                'the bootstrap bucket row carries a different scope',
            );
        }

        $log = (string) @file_get_contents($this->root . '/var/log/app.log');
        self::assertStringContainsString('Request refused by a rate limit.', $log);
        self::assertStringContainsString(RateLimitPolicy::SCOPE_SESSION_BOOTSTRAP_ADDRESS, $log);
        self::assertStringNotContainsString(self::ESZ130_ADDRESS, $log);
        foreach ($ids as $id) {
            self::assertStringNotContainsString($id, $log, 'a log line exposed a session id');
        }
        foreach ($tokens as $token) {
            self::assertStringNotContainsString($token, $log, 'a log line exposed a CSRF token');
        }
    }

    // --- ESZ-140: customer-data retention ----------------------------------

    /**
     * The whole retention matrix: confirmed and cancelled rows on both sides
     * of their own cutoffs, plus not-yet-expired rows that must stay untouched.
     * The suite clock is 2026-06-13T12:00:00Z, so the 90-day cutoff instant is
     * 2026-03-15T12:00:00.000.
     */
    public function testRetentionErasesExactlyTheRowsPastTheirOwnCutoff(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $policy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());

        $service = new BookingRetentionService(
            $this->database,
            $this->clock,
            $policy,
            new NotificationJobRepository(
                $this->database,
                $this->clock,
                NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
            ),
        );

        // Confirmed, ended well past the cutoff — eligible.
        $oldConfirmed = $this->insertRetentionBooking(
            'bk_a0000000000000000000000000000001',
            'confirmed',
            '2025-11-10 10:00:00.000',
            '2025-11-10 11:00:00.000',
            null,
            null,
        );
        // Cancelled, cancelled well past the cutoff — eligible.
        $oldCancelled = $this->insertRetentionBooking(
            'bk_a0000000000000000000000000000002',
            'cancelled',
            '2025-12-01 10:00:00.000',
            '2025-12-01 11:00:00.000',
            '2025-12-01 10:30:00.000',
            'Motif de l\'annulation',
        );
        // Confirmed, ended exactly AT the cutoff instant — eligible (<=).
        $boundaryInside = $this->insertRetentionBooking(
            'bk_a0000000000000000000000000000003',
            'confirmed',
            '2026-03-15 10:00:00.000',
            '2026-03-15 11:00:00.000',
            null,
            null,
        );
        // Confirmed, ended after the cutoff instant — not yet eligible.
        $boundaryOutside = $this->insertRetentionBooking(
            'bk_a0000000000000000000000000000004',
            'confirmed',
            '2026-03-15 12:00:00.000',
            '2026-03-15 13:00:00.000',
            null,
            null,
        );
        // Cancelled recently — not yet eligible.
        $recentCancelled = $this->insertRetentionBooking(
            'bk_a0000000000000000000000000000005',
            'cancelled',
            '2026-05-01 10:00:00.000',
            '2026-05-01 11:00:00.000',
            '2026-05-02 10:00:00.000',
            'motif récent',
        );
        // Confirmed and still upcoming — untouched by design.
        $upcoming = $this->insertRetentionBooking(
            'bk_a0000000000000000000000000000006',
            'confirmed',
            '2026-07-01 08:00:00.000',
            '2026-07-01 09:00:00.000',
            null,
            null,
        );

        $result = $service->applyEligible();

        self::assertSame(3, $result['eligible']);
        self::assertSame(3, $result['erased']);
        self::assertSame(0, $result['retired']);
        self::assertSame('2026-03-15T12:00:00.000Z', $result['cutoffUtc']);

        foreach ([$oldConfirmed, $oldCancelled, $boundaryInside] as $id) {
            $row = $this->retentionRow($id);
            self::assertSame($policy->erasedCustomerName, $row['customer_name'], "booking {$id}");
            self::assertSame($policy->erasedCustomerEmail, $row['customer_email'], "booking {$id}");
            self::assertNull($row['customer_phone'], "booking {$id}");
            self::assertNull($row['customer_note'], "booking {$id}");
            self::assertNull($row['cancellation_reason'], "booking {$id}");
            self::assertSame('2026-06-13 12:00:00.000', $row['customer_data_erased_at'], "booking {$id}");
        }

        foreach ([$boundaryOutside, $recentCancelled, $upcoming] as $id) {
            $row = $this->retentionRow($id);
            self::assertNotNull($row['customer_name'], "booking {$id} was erased");
            self::assertNull($row['customer_data_erased_at'], "booking {$id} was erased");
        }

        // Erased rows keep their identity and appointment evidence; the row is
        // anonymized, never deleted.
        $kept = $this->retentionRow($oldCancelled);
        self::assertSame('bk_a0000000000000000000000000000002', $kept['reference']);
        self::assertSame('cancelled', $kept['state']);
        self::assertSame('2025-12-01 11:00:00.000', $kept['ends_at_utc']);
        self::assertSame('Europe/Paris', $kept['timezone_name']);
        self::assertSame('2025-12-01 10:30:00.000', $kept['cancelled_at_utc']);
        self::assertSame(6, (int) $this->database->fetchOne('SELECT COUNT(*) AS n FROM bookings')['n']);
    }

    /**
     * ESZ-142 — erasure anonymizes the customer fields and keeps the consent
     * evidence intact: `consent_at_utc` and `consent_notice_id` survive byte
     * for byte, for a catalog-era booking (with a notice id) and for a legacy
     * one (null id, whose NULL must not be turned into an invented notice).
     */
    public function testRetentionPreservesConsentEvidenceWhileErasingCustomerPii(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $policy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());
        $service = new BookingRetentionService(
            $this->database,
            $this->clock,
            $policy,
            new NotificationJobRepository(
                $this->database,
                $this->clock,
                NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
            ),
        );

        $this->insertRetentionBooking(
            'bk_c0000000000000000000000000000001',
            'confirmed',
            '2025-11-10 10:00:00.000',
            '2025-11-10 11:00:00.000',
            null,
            null,
            $this->bookingContract->currentConsentNoticeId,
        );
        $this->insertRetentionBooking(
            'bk_c0000000000000000000000000000002',
            'confirmed',
            '2025-11-11 10:00:00.000',
            '2025-11-11 11:00:00.000',
            null,
            null,
            null,
        );

        $result = $service->applyEligible();
        self::assertSame(2, $result['erased']);

        foreach (['bk_c0000000000000000000000000000001', 'bk_c0000000000000000000000000000002'] as $reference) {
            $row = $this->database->fetchOne(
                'SELECT customer_name, customer_email, customer_phone, customer_note,'
                . ' consent_at_utc, consent_notice_id, customer_data_erased_at'
                . ' FROM bookings WHERE reference = :reference',
                ['reference' => $reference],
            );
            self::assertSame($policy->erasedCustomerName, $row['customer_name']);
            self::assertSame($policy->erasedCustomerEmail, $row['customer_email']);
            self::assertNull($row['customer_phone']);
            self::assertNull($row['customer_note']);
            self::assertSame('2025-11-01 09:00:00.000', $row['consent_at_utc'], $reference);
            self::assertNotNull($row['customer_data_erased_at']);
        }

        $catalogRow = $this->database->fetchOne(
            'SELECT consent_notice_id FROM bookings WHERE reference = :reference',
            ['reference' => 'bk_c0000000000000000000000000000001'],
        );
        self::assertSame($this->bookingContract->currentConsentNoticeId, $catalogRow['consent_notice_id']);
        // A legacy row's NULL stays NULL: erasure must never look like the
        // booking accepted a notice it cannot be proven to have seen.
        $legacyRow = $this->database->fetchOne(
            'SELECT consent_notice_id FROM bookings WHERE reference = :reference',
            ['reference' => 'bk_c0000000000000000000000000000002'],
        );
        self::assertNull($legacyRow['consent_notice_id']);
    }

    /**
     * Retention retires every pending and processing job of an erased booking
     * — clearing the lease of a processing job — and leaves terminal jobs
     * (`sent`, `failed`, `skipped`) untouched as delivery evidence.
     */
    public function testRetentionRetiresOnlyNonTerminalJobsAndPreservesTerminalEvidence(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $policy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());
        $service = new BookingRetentionService(
            $this->database,
            $this->clock,
            $policy,
            new NotificationJobRepository(
                $this->database,
                $this->clock,
                NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
            ),
        );

        $bookingId = $this->insertRetentionBooking(
            'bk_b0000000000000000000000000000001',
            'confirmed',
            '2025-11-10 10:00:00.000',
            '2025-11-10 11:00:00.000',
            null,
            null,
        );
        $this->insertRetentionJob($bookingId, 'pending.example.confirmation', 'pending', 0, null, null, null);
        $this->insertRetentionJob(
            $bookingId,
            'processing.example.reminder',
            'processing',
            2,
            'host.99.abcdef012345',
            '2026-06-13 12:30:00.000',
            null,
        );
        $this->insertRetentionJob(
            $bookingId,
            'sent.example.confirmation',
            'sent',
            1,
            null,
            null,
            '2026-05-01 09:00:00.000',
        );
        $this->insertRetentionJob($bookingId, 'failed.example.reminder', 'failed', 5, null, null, null);
        $this->insertRetentionJob($bookingId, 'skipped.example.reminder', 'skipped', 0, null, null, null);

        $result = $service->applyEligible();

        self::assertSame(2, $result['retired']);

        $rows = $this->database->fetchAll(
            'SELECT status, last_error_code, lease_owner, lease_expires_at_utc, sent_at_utc'
            . ' FROM notification_jobs WHERE booking_id = :booking ORDER BY id',
            ['booking' => $bookingId],
        );

        self::assertSame('retired', $rows[0]['status']);
        self::assertSame($policy->erasureJobCode, $rows[0]['last_error_code']);
        self::assertSame('retired', $rows[1]['status']);
        self::assertSame($policy->erasureJobCode, $rows[1]['last_error_code']);
        // The lease of the processing job was cleared by the retirement.
        self::assertNull($rows[1]['lease_owner']);
        self::assertNull($rows[1]['lease_expires_at_utc']);

        // Terminal evidence survives untouched, sent instant included.
        self::assertSame('sent', $rows[2]['status']);
        self::assertSame('2026-05-01 09:00:00.000', $rows[2]['sent_at_utc']);
        self::assertSame('failed', $rows[3]['status']);
        self::assertSame('skipped', $rows[4]['status']);

        self::assertSame(5, (int) $this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM notification_jobs WHERE booking_id = :booking',
            ['booking' => $bookingId],
        )['n'], 'retention deleted notification evidence');
    }

    /**
     * Notification fact resolution reads the e-mail from bookings at delivery
     * time; an erased booking is refused with the frozen retention code, so
     * even a leftover job can never deliver from the erased row.
     */
    public function testNotificationFactResolutionRefusesAnErasedBooking(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $policy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());
        $jobs = new NotificationJobRepository(
            $this->database,
            $this->clock,
            NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
        );
        $service = new BookingRetentionService($this->database, $this->clock, $policy, $jobs);
        $facts = new BookingNotificationFactsRepository($this->database);

        $bookingId = $this->insertRetentionBooking(
            'bk_c0000000000000000000000000000001',
            'confirmed',
            '2025-11-10 10:00:00.000',
            '2025-11-10 11:00:00.000',
            null,
            null,
        );
        $this->insertRetentionJob($bookingId, 'failed.example.reminder', 'failed', 5, null, null, null);
        $job = $jobs->findByIdempotencyKey('failed.example.reminder');
        self::assertNotNull($job);

        // Live booking: facts resolve normally.
        $liveFacts = $facts->forJob($job);
        self::assertSame(self::OLD_EMAIL, $liveFacts->recipientAddress);

        $service->applyEligible();

        try {
            $facts->forJob($job);
            self::fail('facts resolved for an erased booking');
        } catch (PermanentDeliveryException $refusal) {
            self::assertSame('customer_data_erased', $refusal->errorCode);
        }
    }

    /** A second run changes zero rows: eligibility and the marker are re-checked. */
    public function testRepeatedRetentionRunsChangeZeroRows(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $service = new BookingRetentionService(
            $this->database,
            $this->clock,
            RetentionPolicy::fromArtifacts(TestEnvironment::artifacts()),
            new NotificationJobRepository(
                $this->database,
                $this->clock,
                NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
            ),
        );
        $this->insertRetentionBooking(
            'bk_d0000000000000000000000000000001',
            'cancelled',
            '2025-11-10 10:00:00.000',
            '2025-11-10 11:00:00.000',
            '2025-11-10 10:30:00.000',
            'motif',
        );
        $this->insertRetentionJob(
            'bk_d0000000000000000000000000000001',
            'pending.example.confirmation',
            'pending',
            0,
            null,
            null,
            null,
        );

        $first = $service->applyEligible();
        self::assertSame(1, $first['erased']);
        self::assertSame(1, $first['retired']);

        $before = $this->database->fetchAll(
            'SELECT customer_name, customer_email, customer_phone, customer_note,'
            . ' cancellation_reason, customer_data_erased_at'
            . ' FROM bookings ORDER BY id',
        );
        $jobsBefore = $this->database->fetchAll(
            'SELECT status, last_error_code, lease_owner FROM notification_jobs ORDER BY id',
        );

        $second = $service->applyEligible();
        self::assertSame(0, $second['eligible']);
        self::assertSame(0, $second['erased']);
        self::assertSame(0, $second['retired']);

        self::assertSame($before, $this->database->fetchAll(
            'SELECT customer_name, customer_email, customer_phone, customer_note,'
            . ' cancellation_reason, customer_data_erased_at'
            . ' FROM bookings ORDER BY id',
        ));
        self::assertSame($jobsBefore, $this->database->fetchAll(
            'SELECT status, last_error_code, lease_owner FROM notification_jobs ORDER BY id',
        ));
    }

    /**
     * The admin contact editor (ESZ-099) must not be able to repopulate an
     * erased booking: the update — and any other lifecycle write — is refused
     * at the persistence layer, and the row stays anonymized.
     */
    public function testAdminUpdatesCannotReintroducePiiIntoAnErasedBooking(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $service = new BookingRetentionService(
            $this->database,
            $this->clock,
            RetentionPolicy::fromArtifacts(TestEnvironment::artifacts()),
            new NotificationJobRepository(
                $this->database,
                $this->clock,
                NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
            ),
        );
        $reference = 'bk_e0000000000000000000000000000001';
        $this->insertRetentionBooking(
            $reference,
            'cancelled',
            '2025-11-10 10:00:00.000',
            '2025-11-10 11:00:00.000',
            '2025-11-10 10:30:00.000',
            'motif',
        );
        $service->applyEligible();

        // Contact update: refused, even though the admin UI would seed the
        // editor from the server booking's placeholder values. ESZ-139: the
        // request still carries the row's own token, so the refusal is the
        // erasure rule, not a stale-token mismatch.
        try {
            $this->bookingApi->adminMutate([
                'action' => 'update',
                'reference' => $reference,
                'expectedUpdatedAt' => $this->bookingToken($reference),
                'customerName' => 'Nouvelle Cliente',
                'customerEmail' => 'nouvelle@example.test',
                'customerPhone' => '+33 6 12 34 56 78',
                'customerNote' => 'nouvelle note',
            ]);
            self::fail('an erased booking accepted a customer update');
        } catch (BookingValidationException $refusal) {
            self::assertSame('customerDataErasedAt', $refusal->field);
        }

        // Cancelling an erased booking is refused too: a cancellation reason is
        // customer text the erasure CHECK would refuse to store, and an erased
        // row accepts no lifecycle write at all.
        try {
            $this->bookingApi->adminMutate([
                'action' => 'cancel',
                'reference' => $reference,
                'expectedUpdatedAt' => $this->bookingToken($reference),
                'reason' => 'nouveau motif',
            ]);
            self::fail('an erased booking accepted a cancellation');
        } catch (BookingValidationException $refusal) {
            self::assertSame('customerDataErasedAt', $refusal->field);
        }

        $row = $this->retentionRow(
            (int) $this->database->fetchOne(
                'SELECT id FROM bookings WHERE reference = :reference',
                ['reference' => $reference],
            )['id'],
        );
        self::assertSame('Deleted customer', $row['customer_name']);
        self::assertSame('erased@example.invalid', $row['customer_email']);
        self::assertNull($row['customer_note']);
        self::assertNull($row['cancellation_reason']);
        self::assertNotNull($row['customer_data_erased_at']);
    }

    /**
     * Audit of the history producers: across the full lifecycle — created,
     * customer_updated with every field changed, cancelled — the details_json
     * carries field names and instants, never customer values, and retention
     * neither rewrites nor deletes history rows.
     */
    public function testBookingHistoryDetailsJsonNeverHoldsErasedCustomerValues(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availabilityHead(), [$this->weeklyRule(1, '09:00', '12:00')]);
        $service = new BookingRetentionService(
            $this->database,
            $this->clock,
            RetentionPolicy::fromArtifacts(TestEnvironment::artifacts()),
            new NotificationJobRepository(
                $this->database,
                $this->clock,
                NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
            ),
        );

        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $booking = $this->bookings->find((string) $created['reference']);
        self::assertNotNull($booking);
        $this->adminMutateFresh('update', $booking->reference, [
            'customerName' => 'Cliente Modifiée',
            'customerEmail' => 'modifiee@example.test',
            'customerPhone' => '+33 6 98 76 54 32',
            'customerNote' => 'note modifiée',
        ]);
        $this->adminMutateFresh('cancel', $booking->reference, ['reason' => null]);

        // The booking was created inside the 90-day horizon, so it is not yet
        // eligible; age it directly the way the calendar never could.
        $this->database->run(
            'UPDATE bookings SET starts_at_utc = :starts, ends_at_utc = :ends,'
            . ' cancelled_at_utc = :cancelled'
            . ' WHERE id = :id',
            [
                'starts' => '2025-12-01 08:00:00.000',
                'ends' => '2025-12-01 09:00:00.000',
                'cancelled' => '2025-12-02 09:00:00.000',
                'id' => $booking->id,
            ],
        );

        $historyBefore = $this->database->fetchAll(
            'SELECT event_type, actor_type, details_json FROM booking_history'
            . ' WHERE booking_id = :booking ORDER BY id',
            ['booking' => $booking->id],
        );
        self::assertCount(3, $historyBefore);
        $allDetails = implode('', array_column($historyBefore, 'details_json'));
        foreach (
            [
                self::OLD_NAME,
                self::OLD_EMAIL,
                self::OLD_PHONE,
                'Cliente Modifiée',
                'modifiee@example.test',
                '+33 6 98 76 54 32',
                'note modifiée',
            ] as $value
        ) {
            self::assertStringNotContainsString($value, $allDetails, 'a history details_json holds a customer value');
        }

        $service->applyEligible();

        $historyAfter = $this->database->fetchAll(
            'SELECT event_type, actor_type, details_json FROM booking_history'
            . ' WHERE booking_id = :booking ORDER BY id',
            ['booking' => $booking->id],
        );
        self::assertSame($historyBefore, $historyAfter, 'retention rewrote or deleted history rows');
        self::assertSame(1, (int) $this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM bookings WHERE id = :id',
            ['id' => $booking->id],
        )['n'], 'retention deleted the booking row');
    }

    /**
     * The shipped CLI, run twice against the real database: first run erases
     * and retires, second run changes nothing, and neither run prints a
     * booking reference or any seeded customer value.
     */
    public function testTheRetentionCliErasesIdempotentlyAndPrintsNoPii(): void
    {
        $this->leaveTheWrapperTransaction();
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);

        $this->insertRetentionBooking(
            'bk_f0000000000000000000000000000001',
            'confirmed',
            '2025-11-10 10:00:00.000',
            '2025-11-10 11:00:00.000',
            null,
            null,
        );
        $this->insertRetentionJob(
            'bk_f0000000000000000000000000000001',
            'cli.pending.example.confirmation',
            'pending',
            0,
            null,
            null,
            null,
        );
        $this->insertRetentionBooking(
            'bk_f0000000000000000000000000000002',
            'cancelled',
            '2025-12-01 10:00:00.000',
            '2025-12-01 11:00:00.000',
            '2025-12-02 09:00:00.000',
            'motif confidentiel',
        );
        // A recent booking the CLI must leave alone (well inside the real
        // clock's 90-day window).
        $this->insertRetentionBooking(
            'bk_f0000000000000000000000000000003',
            'confirmed',
            '2026-08-01 10:00:00.000',
            '2026-08-01 11:00:00.000',
            null,
            null,
        );

        $settings = TestDatabase::settings();
        $config = TestEnvironment::writeDeployment($this->root, [
            'database' => [
                'dsn' => $settings->dsn,
                'username' => $settings->username,
                'password' => $settings->password,
                'connectTimeoutSeconds' => $settings->connectTimeoutSeconds,
            ],
        ]);

        $binary = TestEnvironment::repositoryRoot() . '/php/bin/apply-booking-retention.php';
        [$firstExit, $firstOut, $firstErr] = $this->runRetentionCli($binary, $config);
        [$secondExit, $secondOut, $secondErr] = $this->runRetentionCli($binary, $config);

        self::assertSame(0, $firstExit);
        self::assertSame(0, $secondExit);
        self::assertSame('', $firstErr);
        self::assertSame('', $secondErr);

        self::assertStringContainsString('status:  completed', $firstOut);
        self::assertStringContainsString('cutoff:  ', $firstOut);
        self::assertStringContainsString('scanned: 2', $firstOut);
        self::assertStringContainsString('erased:  2', $firstOut);
        self::assertStringContainsString('retired: 1', $firstOut);

        // Idempotence at the CLI boundary: the second run changed zero rows.
        self::assertStringContainsString('scanned: 0', $secondOut);
        self::assertStringContainsString('erased:  0', $secondOut);
        self::assertStringContainsString('retired: 0', $secondOut);

        // Counts and cutoffs only: no reference, no customer value, nowhere.
        foreach (
            [
                self::OLD_NAME,
                self::OLD_EMAIL,
                self::OLD_PHONE,
                self::OLD_NOTE,
                'motif confidentiel',
                'bk_f0000000000000000000000000000001',
            ] as $secret
        ) {
            self::assertStringNotContainsString($secret, $firstOut . $firstErr . $secondOut . $secondErr);
        }

        $erased = $this->retentionRow(
            (int) $this->database->fetchOne(
                'SELECT id FROM bookings WHERE reference = :reference',
                ['reference' => 'bk_f0000000000000000000000000000001'],
            )['id'],
        );
        self::assertNotNull($erased['customer_data_erased_at']);
        self::assertNull($this->database->fetchOne(
            'SELECT customer_data_erased_at FROM bookings WHERE reference = :reference',
            ['reference' => 'bk_f0000000000000000000000000000003'],
        )['customer_data_erased_at']);
    }

    /** @return array<string, mixed> */
    private function retentionRow(int $id): array
    {
        $row = $this->database->fetchOne(
            'SELECT reference, state, starts_at_utc, ends_at_utc, timezone_name, customer_name,'
            . ' customer_email, customer_phone, customer_note, cancelled_at_utc,'
            . ' cancellation_reason, customer_data_erased_at'
            . ' FROM bookings WHERE id = :id',
            ['id' => $id],
        );
        self::assertIsArray($row);

        return $row;
    }

    /**
     * Inserts a booking row with full customer PII and explicit lifecycle
     * instants, so a test can place a booking anywhere relative to the
     * retention cutoff.
     *
     * @param string|null $consentNoticeId ESZ-142 — the catalog notice id to
     *     store; null (the default) writes a legacy row with no notice id.
     */
    private function insertRetentionBooking(
        string $reference,
        string $state,
        string $starts,
        string $ends,
        ?string $cancelledAt,
        ?string $reason,
        ?string $consentNoticeId = null,
    ): int {
        $this->database->run(
            'INSERT INTO bookings (reference, service_key, state, starts_at_utc, ends_at_utc,'
            . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
            . ' consent_at_utc, consent_notice_id, cancelled_at_utc, cancellation_reason,'
            . ' created_at, updated_at, state_changed_at)'
            . ' VALUES (:reference, :service, :state, :starts, :ends, :timezone, :name, :email,'
            . ' :phone, :note, :consent, :notice, :cancelled, :reason, :created, :updated, :changed)',
            [
                'reference' => $reference,
                'service' => 'brows',
                'state' => $state,
                'starts' => $starts,
                'ends' => $ends,
                'timezone' => 'Europe/Paris',
                'name' => self::OLD_NAME,
                'email' => self::OLD_EMAIL,
                'phone' => self::OLD_PHONE,
                'note' => self::OLD_NOTE,
                'consent' => '2025-11-01 09:00:00.000',
                'notice' => $consentNoticeId,
                'cancelled' => $cancelledAt,
                'reason' => $reason,
                'created' => self::NOW,
                'updated' => self::NOW,
                'changed' => self::NOW,
            ],
        );

        return (int) $this->database->pdo()->lastInsertId();
    }

    /**
     * Inserts one notification job for a booking named by id or reference.
     */
    private function insertRetentionJob(
        int|string $booking,
        string $key,
        string $status,
        int $attempts,
        ?string $leaseOwner,
        ?string $leaseExpires,
        ?string $sentAt,
    ): void {
        if (\is_string($booking)) {
            $bookingId = (int) $this->database->fetchOne(
                'SELECT id FROM bookings WHERE reference = :reference',
                ['reference' => $booking],
            )['id'];
        } else {
            $bookingId = $booking;
        }
        $this->database->run(
            'INSERT INTO notification_jobs (idempotency_key, booking_id, channel, job_type,'
            . ' due_at_utc, next_attempt_at_utc, status, attempts, last_error_code, sent_at_utc,'
            . ' lease_owner, lease_expires_at_utc, created_at, updated_at, status_changed_at)'
            . ' VALUES (:key, :booking, :channel, :type, :due, :next, :status, :attempts, :code,'
            . ' :sentAt, :leaseOwner, :leaseExpires, :created, :updated, :changed)',
            [
                'key' => $key,
                'booking' => $bookingId,
                'channel' => 'email',
                'type' => 'booking_confirmation',
                'due' => '2026-06-13 12:00:00.000',
                'next' => '2026-06-13 12:00:00.000',
                'status' => $status,
                'attempts' => $attempts,
                'code' => $status === 'failed' ? 'attempts_exhausted' : null,
                'sentAt' => $sentAt,
                'leaseOwner' => $leaseOwner,
                'leaseExpires' => $leaseExpires,
                'created' => self::NOW,
                'updated' => self::NOW,
                'changed' => self::NOW,
            ],
        );
    }

    /** @return array{int, string, string} */
    private function runRetentionCli(string $binary, string $config): array
    {
        $pipes = [];
        $process = proc_open(
            [PHP_BINARY, $binary, '--config=' . $config],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            TestEnvironment::repositoryRoot(),
        );
        self::assertIsResource($process);
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        return [proc_close($process), (string) $stdout, (string) $stderr];
    }

    // --- ESZ-134 helpers ----------------------------------------------------

    /**
     * Leaves the suite's rollback-only wrapper, like the booking rollback proof
     * does, so a production-wired kernel with its own connection can commit and
     * roll back real rows instead of sharing the test's transaction.
     */
    private function leaveTheWrapperTransaction(): void
    {
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);
    }

    /**
     * The full production wiring: Kernel::boot over a deployment configuration
     * pointing at the disposable MySQL, with no seams. The kernel opens its own
     * connection, exactly as public/api/index.php would.
     *
     * @param Clock $clock Any Clock; {@see MovableClock} is used by the ESZ-130
     *        proofs that must let time pass between requests (idle sliding,
     *        allowance refill).
     */
    private function bootProductionKernel(
        string $root,
        Clock $clock,
        string $logLevel = 'error',
    ): Kernel {
        $settings = TestDatabase::settings();
        $configPath = TestEnvironment::writeDeployment($root, [
            'logLevel' => $logLevel,
            'database' => [
                'dsn' => $settings->dsn,
                'username' => $settings->username,
                'password' => $settings->password,
                'connectTimeoutSeconds' => $settings->connectTimeoutSeconds,
            ],
        ]);

        return Kernel::boot($configPath, $clock);
    }

    /**
     * An account whose hash the current PASSWORD_DEFAULT considers outdated, so
     * the very next successful login must rehash it. Inserted directly because
     * provisioning always writes a current hash.
     */
    private function insertLegacyHashAccount(string $password): string
    {
        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);

        $this->database->run(
            'INSERT INTO admin_accounts (email, password_hash, is_enabled, created_at, updated_at)'
            . ' VALUES (:email, :hash, 1, :created_at, :updated_at)',
            [
                'email' => self::EMAIL,
                'hash' => $hash,
                // PDO native prepares forbid reusing one named parameter, so the
                // two identical timestamps are two parameters.
                'created_at' => self::NOW,
                'updated_at' => self::NOW,
            ],
        );

        return $hash;
    }

    /**
     * A real MySQL fault injection: the moment recordLogin writes the
     * ESZ-134 kernel clock into last_login_at, the statement fails. Scoped to
     * that one value so a leftover trigger could never misfire on the suite's
     * own 2026-clock rows.
     */
    private function installRecordLoginFailureTrigger(): void
    {
        $this->database->executeRaw('DROP TRIGGER IF EXISTS esz134_login_record_failure', 'reset esz134 login trigger');
        $this->database->executeRaw(
            'CREATE TRIGGER esz134_login_record_failure BEFORE UPDATE ON admin_accounts'
            . ' FOR EACH ROW'
            . " BEGIN IF NEW.last_login_at = '" . self::FAILED_LOGIN_NOW . "' THEN"
            . " SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'esz134 forced recordLogin failure';"
            . ' END IF; END',
            'create esz134 login trigger',
        );
    }

    private function removeRecordLoginFailureTrigger(): void
    {
        $this->database->executeRaw('DROP TRIGGER IF EXISTS esz134_login_record_failure', 'drop esz134 login trigger');
    }

    /**
     * A real MySQL fault injection scoped to a legacy cost-10 hash being
     * rewritten: exactly the write upgradeHash performs, and no other.
     */
    private function installRehashFailureTrigger(): void
    {
        $this->database->executeRaw('DROP TRIGGER IF EXISTS esz134_rehash_failure', 'reset esz134 rehash trigger');
        $this->database->executeRaw(
            'CREATE TRIGGER esz134_rehash_failure BEFORE UPDATE ON admin_accounts'
            . ' FOR EACH ROW'
            . " BEGIN IF OLD.password_hash LIKE '$2y$10$%' AND NEW.password_hash <> OLD.password_hash THEN"
            . " SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'esz134 forced rehash failure';"
            . ' END IF; END',
            'create esz134 rehash trigger',
        );
    }

    private function removeRehashFailureTrigger(): void
    {
        $this->database->executeRaw('DROP TRIGGER IF EXISTS esz134_rehash_failure', 'drop esz134 rehash trigger');
    }

    // --- ESZ-101 helpers -----------------------------------------------------

    /**
     * A deployment configuration pointing at the disposable MySQL, for operator
     * CLIs (provision-admin) that open their own connection and commit.
     */
    private function provisionCliConfig(): string
    {
        $settings = TestDatabase::settings();

        return TestEnvironment::writeDeployment($this->root, [
            'database' => [
                'dsn' => $settings->dsn,
                'username' => $settings->username,
                'password' => $settings->password,
                'connectTimeoutSeconds' => $settings->connectTimeoutSeconds,
            ],
        ]);
    }

    /**
     * Drives the real provision-admin CLI with a piped password, the same shape
     * an operator automation uses (ESZ-132: no `--password` argument anywhere).
     *
     * @return array{int, string, string}
     */
    private function runProvisionAdmin(string $config, string $email, string $password): array
    {
        $pipes = [];
        $process = proc_open(
            [
                PHP_BINARY,
                TestEnvironment::repositoryRoot() . '/php/bin/provision-admin.php',
                '--config=' . $config,
                '--email=' . $email,
                '--set-password',
            ],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            TestEnvironment::repositoryRoot(),
        );
        self::assertIsResource($process);
        fwrite($pipes[0], $password . "\n");
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        return [proc_close($process), (string) $stdout, (string) $stderr];
    }

    private function sessionCountFor(int $accountId): int
    {
        return (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM admin_sessions WHERE account_id = :account_id',
            ['account_id' => $accountId],
        )['n'] ?? 0);
    }

    /**
     * A real MySQL fault injection for ESZ-101: every session-row deletion
     * fails, exactly what a revocation or a logout needs to perform.
     */
    private function installSessionDeleteFailureTrigger(): void
    {
        $this->database->executeRaw(
            'DROP TRIGGER IF EXISTS esz101_session_delete_failure',
            'reset esz101 delete trigger',
        );
        $this->database->executeRaw(
            'CREATE TRIGGER esz101_session_delete_failure BEFORE DELETE ON admin_sessions'
            . ' FOR EACH ROW'
            . " SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'esz101 forced session delete failure';",
            'create esz101 delete trigger',
        );
    }

    private function removeSessionDeleteFailureTrigger(): void
    {
        $this->database->executeRaw(
            'DROP TRIGGER IF EXISTS esz101_session_delete_failure',
            'drop esz101 delete trigger',
        );
    }

    // --- ESZ-130 helpers ----------------------------------------------------

    /** One anonymous-session read from the ESZ-130 client address. */
    private function esz130Read(?string $cookie = null): Request
    {
        $headers = $cookie === null
            ? []
            : ['cookie' => $this->cookieName() . '=' . $cookie];

        return new Request('GET', '/api/auth/session', $headers, '', [], self::ESZ130_ADDRESS);
    }

    private function esz130SessionCount(): int
    {
        return (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM admin_sessions',
        )['n'] ?? 0);
    }

    /** Rows past either deadline — the ones a sweep pass is allowed to remove. */
    private function esz130DeadCount(): int
    {
        $now = $this->clock->nowIso();

        return (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM admin_sessions'
            . ' WHERE expires_at <= :idle_now OR absolute_expires_at <= :absolute_now',
            ['idle_now' => $now, 'absolute_now' => $now],
        )['n'] ?? 0);
    }

    /**
     * Bulk-inserts dead session rows for the bounded-sweep proof.
     *
     * `idle` rows are past only their idle deadline; `absolute` rows are past
     * only their absolute one — the two classes are disjoint so each sweep pass
     * removes exactly its batch from the class it targets and the per-deadline
     * bound is observable. Deadlines are derived from the suite clock, which is
     * the clock the ESZ-130 kernels boot with.
     */
    private function insertDeadSessions(int $count, string $mode): void
    {
        $now = $this->clock->nowIso();
        $past = $this->at('-1 minute');
        $future = $this->at('+2 hours');
        [$idleDeadline, $absoluteDeadline] = $mode === 'idle'
            ? [$past, $future]
            : [$future, $past];

        $columns = '(id, account_id, csrf_token, created_at, last_seen_at, expires_at, absolute_expires_at)';
        $chunks = array_chunk(range(1, $count), 100);

        foreach ($chunks as $chunk) {
            $values = [];
            $params = [];

            foreach ($chunk as $index) {
                $values[] = '(:id' . $index . ', NULL, :csrf' . $index . ', :created' . $index
                    . ', :seen' . $index . ', :idle' . $index . ', :absolute' . $index . ')';
                $params['id' . $index] = Session::newId();
                $params['csrf' . $index] = Session::newCsrfToken();
                $params['created' . $index] = $now;
                $params['seen' . $index] = $now;
                $params['idle' . $index] = $idleDeadline;
                $params['absolute' . $index] = $absoluteDeadline;
            }

            $this->database->run(
                'INSERT INTO admin_sessions ' . $columns . ' VALUES ' . implode(', ', $values),
                $params,
            );
        }
    }

    /**
     * A real MySQL fault injection for ESZ-130: every session-row deletion
     * fails, exactly what the bootstrap sweep performs on its first admitted
     * read.
     */
    private function installEs130SweepFailureTrigger(): void
    {
        $this->database->executeRaw(
            'DROP TRIGGER IF EXISTS esz130_sweep_delete_failure',
            'reset esz130 sweep trigger',
        );
        $this->database->executeRaw(
            'CREATE TRIGGER esz130_sweep_delete_failure BEFORE DELETE ON admin_sessions'
            . ' FOR EACH ROW'
            . " SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'esz130 forced sweep failure';",
            'create esz130 sweep trigger',
        );
    }

    private function removeEs130SweepFailureTrigger(): void
    {
        $this->database->executeRaw(
            'DROP TRIGGER IF EXISTS esz130_sweep_delete_failure',
            'drop esz130 sweep trigger',
        );
    }
}
