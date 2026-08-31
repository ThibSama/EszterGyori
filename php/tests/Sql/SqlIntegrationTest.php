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
use Eszter\Booking\Booking;
use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingRepository;
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
use Eszter\Notification\BookingNotificationProducer;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Support\FrozenClock;
use Eszter\Support\IsoTimestamp;
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
            '+33600000000',
            'Test only',
            new \DateTimeImmutable('2026-06-13T12:00:00.000Z'),
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
        self::assertSame('2026-06-13 12:00:00.000', $cancelled->cancelledAtUtc);
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
        $this->availability->replaceWeeklyRules($rules);

        $stored = $this->availability->weeklyRules();
        self::assertCount(3, $stored);
        self::assertSame([1, 1, 3], array_column($stored, 'weekdayIso'));
        self::assertNull($stored[0]->validFrom);
        self::assertNull($stored[1]->validUntil);

        try {
            $this->availability->replaceWeeklyRules([
                $this->weeklyRule(1, '09:00', '12:00'),
                $this->weeklyRule(1, '11:45', '13:00'),
            ]);
            self::fail('Overlapping weekly rules were stored.');
        } catch (BookingValidationException $exception) {
            self::assertSame('weeklyRules', $exception->field);
        }
        self::assertCount(3, $this->availability->weeklyRules(), 'failed replace changed stored rules');

        $this->availability->replaceWeeklyRules([
            $this->weeklyRule(1, '09:00', '10:00', null, '2026-06-30'),
            $this->weeklyRule(1, '09:00', '10:00', '2026-07-01', null),
            $this->weeklyRule(1, '10:00', '11:00'),
        ]);
        self::assertCount(3, $this->availability->weeklyRules());
    }

    public function testOneDateExceptionStoresOrderedReplacementWindowsAndCanBecomeClosed(): void
    {
        try {
            $this->availability->putOpenException('2026-07-14', [
                $this->availabilityWindow('09:00', '12:00'),
                $this->availabilityWindow('11:00', '14:00'),
            ]);
            self::fail('Overlapping exception windows were stored.');
        } catch (BookingValidationException $exception) {
            self::assertSame('windows', $exception->field);
        }
        self::assertNull($this->availability->findException('2026-07-14'));

        $open = $this->availability->putOpenException('2026-07-14', [
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

        $closed = $this->availability->putClosedException('2026-07-14', 'Public holiday');
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
                '2026-03-29',
                [$this->availabilityWindow('02:15', '03:30')],
            );
            self::fail('A spring-gap boundary was stored.');
        } catch (BookingValidationException) {
            self::addToAssertionCount(1);
        }

        try {
            $this->availability->putOpenException(
                '2026-10-25',
                [$this->availabilityWindow('02:00', '03:00')],
            );
            self::fail('An ambiguous fold boundary was stored without an offset.');
        } catch (BookingValidationException) {
            self::addToAssertionCount(1);
        }

        $stored = $this->availability->putOpenException(
            '2026-10-25',
            [$this->availabilityWindow('02:00', '03:00', '+01:00')],
        );
        self::assertSame('+01:00', $stored->windows[0]->foldUtcOffset);
    }

    public function testMysqlOccupancyExpandsBuffersAndCancellationStopsBlocking(): void
    {
        $service = $this->bookingServices->provision('brows', 'Sourcils', 30, 15, 15, true)['service'];
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '12:00')]);
        $booking = $this->bookings->createConfirmed(
            'brows',
            new \DateTimeImmutable('2026-07-06T08:00:00Z'),
            new \DateTimeImmutable('2026-07-06T08:30:00Z'),
            'Cliente Exemple',
            'cliente@example.test',
            null,
            null,
            new \DateTimeImmutable(self::NOW),
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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '12:00')]);
        $this->availability->putOpenException(
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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '11:00')]);

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
        $this->availability->replaceWeeklyRules([
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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '11:00')]);

        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $stored = $this->bookings->find((string) $created['reference']);

        self::assertNotNull($stored);
        self::assertSame('confirmed', $created['state']);
        self::assertSame('2026-06-13 12:00:00.000', $stored->consentAtUtc);
        self::assertSame('Cliente Exemple', $stored->customerName);
        $history = $this->database->fetchAll(
            'SELECT event_type, actor_type FROM booking_history WHERE booking_id = :booking',
            ['booking' => $stored->id],
        );
        self::assertSame([['event_type' => 'created', 'actor_type' => 'public']], $history);
        self::assertArrayNotHasKey('customerEmail', $created);
    }

    public function testBookingLifecycleProducesStableAtomicEmailJobsAndSupersedesReminders(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '12:00')]);

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

        $this->bookingApi->adminMutate([
            'action' => 'move',
            'reference' => $booking->reference,
            'startsAtUtc' => '2026-06-15T08:00:00.000Z',
        ]);
        $moved = $this->notificationRows($booking->id);
        self::assertSame(
            ['booking_confirmation', 'booking_reminder', 'booking_moved', 'booking_reminder'],
            array_column($moved, 'job_type'),
        );
        self::assertSame('skipped', $moved[1]['status']);
        self::assertSame('reminder_superseded', $moved[1]['last_error_code']);
        self::assertSame('2026-06-14 08:00:00.000', $moved[3]['due_at_utc']);

        $this->bookingApi->adminMutate([
            'action' => 'cancel',
            'reference' => $booking->reference,
            'reason' => null,
        ]);
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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '12:00')]);
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

        $this->bookingApi->adminMutate([
            'action' => 'move',
            'reference' => $booking->reference,
            'startsAtUtc' => '2026-06-15T08:00:00.000Z',
        ]);
        $rows = $this->notificationRows($booking->id);

        self::assertSame('sent', $rows[1]['status']);
        self::assertNull($rows[1]['last_error_code']);
        self::assertSame('booking_reminder', $rows[3]['job_type']);
        self::assertSame('pending', $rows[3]['status']);
    }

    public function testReminderAlreadyOutsideCatchUpIsRecordedAsTerminalSkip(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules([$this->weeklyRule(7, '09:00', '10:00')]);

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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '10:00')]);
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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '11:00')]);
        $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:15:00.000Z'));

        $this->expectException(SlotUnavailableException::class);
        $this->bookingApi->create($this->publicBookingRequest('lips', '2026-06-15T07:30:00.000Z'));
    }

    public function testAdminUpdateMoveCancelAndReadAppendHistoryWithoutReplacingTheRow(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '12:00')]);
        $created = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        $reference = (string) $created['reference'];
        $id = $this->bookings->find($reference)?->id;

        $this->bookingApi->adminMutate([
            'action' => 'update',
            'reference' => $reference,
            'customerName' => 'Cliente Corrigée',
            'customerEmail' => 'corrigee@example.test',
            'customerPhone' => null,
            'customerNote' => 'Corrigé',
        ]);
        $this->bookingApi->adminMutate([
            'action' => 'move',
            'reference' => $reference,
            'startsAtUtc' => '2026-06-15T08:00:00.000Z',
        ]);
        $cancelled = $this->bookingApi->adminMutate([
            'action' => 'cancel',
            'reference' => $reference,
            'reason' => 'Cliente indisponible',
        ]);
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
        $this->bookingApi->adminMutate([
            'action' => 'move',
            'reference' => $reference,
            'startsAtUtc' => '2026-06-15T09:00:00.000Z',
        ]);
    }

    public function testAdminMoveRevalidatesAgainstAnotherServiceAndLeavesSourceUntouched(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 30, 15, 15, true);
        $this->bookingServices->provision('lips', 'Lèvres', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '12:00')]);
        $source = $this->bookingApi->create($this->publicBookingRequest('brows', '2026-06-15T07:15:00.000Z'));
        $this->bookingApi->create($this->publicBookingRequest('lips', '2026-06-15T09:00:00.000Z'));

        try {
            $this->bookingApi->adminMutate([
                'action' => 'move',
                'reference' => $source['reference'],
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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '12:00')]);
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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '11:00')]);
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
        $this->availability->replaceWeeklyRules([$this->weeklyRule(1, '09:00', '11:00')]);

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

    // --- ESZ-063 / ESZ-064 / ESZ-065: availability administration -----------

    public function testWeeklyReplacementStoresTheWholeSetAndReturnsStoredState(): void
    {
        $result = $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => [
            $this->weeklyRulePayload(2, '14:00', '18:00'),
            $this->weeklyRulePayload(2, '09:00', '12:30'),
            $this->weeklyRulePayload(4, '10:00', '13:00', '2026-09-01', '2026-12-31', false),
        ]]);

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
        $second = $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => [
            $this->weeklyRulePayload(1, '09:00', '10:00'),
        ]]);
        self::assertCount(1, $second['weeklyRules']);
        self::assertSame(1, (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM availability_rules',
        )['n'] ?? 0));
    }

    public function testARefusedWeeklyReplacementLeavesThePreviousScheduleExactlyAsItWas(): void
    {
        $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => [
            $this->weeklyRulePayload(1, '09:00', '12:00'),
            $this->weeklyRulePayload(2, '09:00', '12:00'),
            $this->weeklyRulePayload(3, '09:00', '12:00'),
        ]]);
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
                $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => $rules]);
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
        $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => [
            $this->weeklyRulePayload(1, '09:00', '12:00'),
        ]]);

        $result = $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => []]);

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
        $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => [
            $this->weeklyRulePayload(1, '09:00', '12:00'),
            $this->weeklyRulePayload(2, '09:00', '12:00'),
            $this->weeklyRulePayload(3, '09:00', '12:00'),
        ]]);

        // Hold exactly the boundary `replaceWeeklyRules` takes before it deletes.
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
        $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => [
            $this->weeklyRulePayload(1, '09:00', '12:00'),
        ]]);

        self::assertSame(
            ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30'],
            $this->localStarts('2026-06-15'),
        );

        // A closure replaces the weekly windows with nothing.
        $closed = $this->bookingApi->adminMutateAvailabilityException([
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
        $open = $this->bookingApi->adminMutateAvailabilityException([
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
        $removed = $this->bookingApi->adminMutateAvailabilityException([
            'action' => 'remove',
            'localDate' => '2026-06-15',
        ]);
        self::assertNull($removed['exception']);
        self::assertNull($this->availability->findException('2026-06-15'));
        self::assertSame('09:00', $this->localStarts('2026-06-15')[0] ?? null);
        self::assertCount(11, $this->localStarts('2026-06-15'));

        // Removing an exception that is not there is satisfied, not an error.
        self::assertNull($this->bookingApi->adminMutateAvailabilityException([
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
                $this->bookingApi->adminMutateAvailabilityException([
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
            $this->bookingApi->adminMutateAvailabilityException([
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
            $this->bookingApi->adminMutateAvailabilityException([
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
        $stored = $this->bookingApi->adminMutateAvailabilityException([
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
        $ordinary = $this->bookingApi->adminMutateAvailabilityException([
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
        $this->bookingApi->adminReplaceWeeklyAvailability(['rules' => [
            $this->weeklyRulePayload(1, '09:00', '12:00'),
        ]]);
        foreach (['2026-05-30', '2026-06-15', '2026-07-20'] as $date) {
            $this->bookingApi->adminMutateAvailabilityException([
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

        $weekly = ['rules' => [$this->weeklyRulePayload(1, '09:00', '12:00')]];
        $exception = ['action' => 'close', 'localDate' => '2026-06-15', 'note' => null];
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

    // --- ESZ-085: query bounds -------------------------------------------

    /**
     * A ranged booking read is bounded by rows as well as by dates.
     *
     * The callers already bound the range to 90 days, and until Package 8.2 that
     * was the only bound there was. A range is not a bound on rows: how many
     * bookings fall inside 90 days is decided by how busy the site is, not by the
     * query, so the response size and the memory this method allocates had no
     * ceiling. The cap is far above what one practitioner can book in a quarter,
     * which is what makes it a guard rather than pagination — reaching it means
     * something has gone wrong, not that a page is missing.
     */
    public function testARangedBookingReadIsCappedByRowsAndNotOnlyByDates(): void
    {
        $this->bookingServices->provision('brows', 'Sourcils', 120, 0, 0, true);

        $limit = $this->bookingContract->slotMaxResults;
        $values = [];
        $parameters = [];

        // Inserted directly rather than through createConfirmed(): the point is a
        // table with more rows in range than the cap allows, and the domain rules
        // that stop two appointments overlapping would make that impossible to
        // arrange honestly. One statement, so the fixture is not the slow part.
        for ($i = 0; $i <= $limit; ++$i) {
            $start = (new \DateTimeImmutable('2026-07-01T06:00:00Z'))->modify("+{$i} minutes");
            $end = $start->modify('+1 minute');

            $values[] = "(:ref{$i}, 'brows', 'confirmed', :start{$i}, :end{$i}, 'Europe/Paris',"
                . " 'Cliente', 'cliente@example.test', NULL, NULL, :consent{$i}, NULL, NULL,"
                . " :created{$i}, :updated{$i}, :changed{$i})";

            $parameters["ref{$i}"] = 'bk_' . str_pad(dechex($i), 32, '0', STR_PAD_LEFT);
            $parameters["start{$i}"] = $start->format('Y-m-d H:i:s');
            $parameters["end{$i}"] = $end->format('Y-m-d H:i:s');
            // DATETIME columns, so the wire ISO form is not what goes in.
            $stamp = (new \DateTimeImmutable(self::NOW))->format('Y-m-d H:i:s');
            $parameters["consent{$i}"] = $stamp;
            $parameters["created{$i}"] = $stamp;
            $parameters["updated{$i}"] = $stamp;
            $parameters["changed{$i}"] = $stamp;
        }

        $this->database->run(
            'INSERT INTO bookings (reference, service_key, state, starts_at_utc, ends_at_utc,'
            . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
            . ' consent_at_utc, cancelled_at_utc, cancellation_reason, created_at, updated_at,'
            . ' state_changed_at) VALUES ' . implode(', ', $values),
            $parameters,
        );

        $listed = $this->bookings->listBetween(
            new \DateTimeImmutable('2026-06-01T00:00:00Z'),
            new \DateTimeImmutable('2026-08-01T00:00:00Z'),
        );

        self::assertCount(
            $limit,
            $listed,
            'a ranged read returned more rows than the contract\'s own result ceiling',
        );
    }
}
