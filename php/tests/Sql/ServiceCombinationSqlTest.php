<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Booking\AvailabilityRepository;
use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\BookableServiceRevisionConflictException;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingSerializationLock;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\PdoBookingApi;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Notification\NotificationPolicy;
use Eszter\Tests\MovableClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-150 — several services in one appointment, against the disposable
 * MySQL, under the corrected default-allow rule of domain version 15.
 *
 * What is proved, each as its own test:
 *
 *  - a combination with no stored row at all is bookable for the sum of its
 *    component durations — availability and creation agreeing on the same
 *    interval, with nothing materialised in `booking_service_combinations`;
 *    a stored custom duration then overrides that sum for exactly that
 *    membership, a later component-duration edit moves every implicit
 *    duration without rewriting the custom one or any stored booking, and
 *    clearing the custom duration returns the membership to the sum;
 *  - the configured maximum bounds public selection: the default is one, a
 *    selection above the maximum is refused, an *explicitly disabled*
 *    combination is refused (and is the only combination of active services
 *    that is), re-enabling it returns it to the default policy, and
 *    archiving a member removes it from new bookings while the historical
 *    booking keeps its stored facts;
 *  - a single-service booking made before any combination existed keeps a
 *    null combination and exactly its facts.
 */
final class ServiceCombinationSqlTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private static bool $migrated = false;

    private \Eszter\Database\Database $database;
    private MovableClock $clock;
    private BookingDomainContract $contract;
    private BookableServiceRepository $services;
    private AvailabilityRepository $availability;
    private PdoBookingApi $api;

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
        $this->contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
        $serialization = new BookingSerializationLock($this->database);
        $this->services = new BookableServiceRepository($this->database, $this->clock, $this->contract, $serialization);
        $this->availability = new AvailabilityRepository(
            $this->database,
            $this->clock,
            $this->contract,
            new BookingTimePolicy($this->contract),
            $serialization,
        );
        $this->api = PdoBookingApi::createDefault(
            $this->database,
            $this->clock,
            $this->contract,
            NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
        );

        // Two services with buffers that differ, so the snapshot is visible.
        $this->services->provision('brows', 'Sourcils', 30, 5, 0, true);
        $this->services->provision('lips', 'Lèvres', 60, 0, 10, true);
        $this->availability->replaceWeeklyRules($this->availability->revision(), [new WeeklyAvailabilityRule(
            0,
            1,
            AvailabilityWindow::create('09:00', '13:00', null, $this->contract),
            null,
            null,
            true,
        )]);

        $this->database->beginTransaction();
    }

    protected function tearDown(): void
    {
        if (isset($this->database) && $this->database->inTransaction()) {
            $this->database->rollBack();
        }
    }

    // --- Proof 1: the default is the sum; a stored duration overrides it ------

    public function testAnUnstoredCombinationIsBookableForTheSumAndACustomDurationOverridesIt(): void
    {
        // A single-service booking made before any combination exists.
        // (09:15 local: the 5-minute before-buffer cannot precede the window.)
        $single = $this->api->create($this->publicBookingRequest(['brows'], '2026-06-15T07:15:00.000Z'));
        self::assertSame(['brows'], $single['serviceKeys']);
        self::assertNull($single['combinationKey']);

        $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 2]);
        $public = $this->api->services();
        self::assertSame(2, $public['maxServicesPerAppointment']);
        // Nothing is published, because nothing was overridden: the pair is
        // offered by the rule itself, not by a row.
        self::assertSame([], $public['combinations']);
        self::assertSame([], $this->database->fetchAll('SELECT combination_key FROM booking_service_combinations'));

        // Availability for the unstored pair: 30 + 60 = 90 minutes, with the
        // members' own buffers (5 before, 10 after).
        $slots = $this->api->availability([
            'serviceKeys' => ['lips', 'brows'],
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ]);
        self::assertSame('brows', $slots['serviceKey']);
        self::assertSame(['brows', 'lips'], $slots['serviceKeys']);
        self::assertSame('brows+lips', $slots['combinationKey']);
        self::assertNotSame([], $slots['slots']);
        foreach ($slots['slots'] as $slot) {
            self::assertSame(90 * 60, strtotime($slot['endsAtUtc']) - strtotime($slot['startsAtUtc']));
        }

        // Creation agrees with availability on exactly that offer, stores the
        // first member beside the canonical combination key — and still
        // materialises no combination row.
        $start = $slots['slots'][0]['startsAtUtc'];
        $booking = $this->api->create($this->publicBookingRequest(['lips', 'brows'], $start));
        self::assertSame('brows', $booking['serviceKey']);
        self::assertSame(['brows', 'lips'], $booking['serviceKeys']);
        self::assertSame('brows+lips', $booking['combinationKey']);
        self::assertSame(strtotime($start) + 90 * 60, strtotime($booking['endsAtUtc']));
        self::assertSame(
            ['service_key' => 'brows', 'combination_key' => 'brows+lips'],
            $this->database->fetchOne(
                'SELECT service_key, combination_key FROM bookings WHERE reference = :reference',
                ['reference' => $booking['reference']],
            ),
        );
        self::assertSame([], $this->database->fetchAll('SELECT combination_key FROM booking_service_combinations'));

        // The back-office lists that pair as active by default, with no token.
        $admin = $this->api->adminServices();
        self::assertTrue($admin['combinationsComplete']);
        self::assertSame(['brows+lips'], array_column($admin['combinations'], 'key'));
        self::assertSame('default', $admin['combinations'][0]['status']);
        self::assertTrue($admin['combinations'][0]['bookable']);
        self::assertSame(90, $admin['combinations'][0]['proposedDurationMinutes']);
        self::assertNull($admin['combinations'][0]['durationMinutes']);
        self::assertSame(90, $admin['combinations'][0]['effectiveDurationMinutes']);
        self::assertNull($admin['combinations'][0]['updatedAt']);

        // Esther pins 75 minutes for that exact membership. It is now an
        // override: published as one, and authoritative for new slots.
        $this->clock->advanceSeconds(1);
        $validated = $this->api->adminMutateService([
            'action' => 'validateCombination',
            'serviceKeys' => ['lips', 'brows'],
            'durationMinutes' => 75,
            'expectedUpdatedAt' => null,
        ]);
        self::assertSame('brows+lips', $validated['combination']['key']);
        self::assertSame('validated', $validated['combination']['status']);
        self::assertSame(75, $validated['combination']['durationMinutes']);
        self::assertSame(75, $validated['combination']['effectiveDurationMinutes']);
        self::assertTrue($validated['combination']['bookable']);
        self::assertSame(
            [[
                'key' => 'brows+lips',
                'serviceKeys' => ['brows', 'lips'],
                'durationMinutes' => 75,
                'bookable' => true,
            ]],
            $this->api->services()['combinations'],
        );
        $custom = $this->api->availability([
            'serviceKeys' => ['brows', 'lips'],
            'fromDate' => '2026-06-22',
            'untilDate' => '2026-06-22',
        ]);
        self::assertNotSame([], $custom['slots']);
        foreach ($custom['slots'] as $slot) {
            self::assertSame(75 * 60, strtotime($slot['endsAtUtc']) - strtotime($slot['startsAtUtc']));
        }

        // A component edit moves every *implicit* duration and never the
        // custom one, nor any stored booking.
        $this->clock->advanceSeconds(1);
        $brows = $this->services->find('brows');
        self::assertNotNull($brows);
        $this->services->update('brows', $brows->updatedAt, 'Sourcils', '', 45, null);
        $this->services->provision('freckles', 'Taches de rousseur', 20, 0, 0, true);
        $admin = $this->api->adminServices();
        $byKey = array_column($admin['combinations'], null, 'key');
        self::assertSame(105, $byKey['brows+lips']['proposedDurationMinutes']);
        self::assertSame(75, $byKey['brows+lips']['durationMinutes']);
        self::assertSame(75, $byKey['brows+lips']['effectiveDurationMinutes']);
        // The implicit pair follows its components without being touched.
        self::assertSame('default', $byKey['brows+freckles']['status']);
        self::assertSame(65, $byKey['brows+freckles']['effectiveDurationMinutes']);
        self::assertNull($byKey['brows+freckles']['durationMinutes']);
        $detail = $this->api->adminQuery(['mode' => 'reference', 'reference' => $booking['reference']]);
        self::assertSame(strtotime($start) + 90 * 60, strtotime($detail['booking']['endsAtUtc']));
        self::assertSame(['brows', 'lips'], $detail['booking']['serviceKeys']);
        $legacy = $this->api->adminQuery(['mode' => 'reference', 'reference' => $single['reference']]);
        self::assertSame('2026-06-15T07:45:00.000Z', $legacy['booking']['endsAtUtc']);
        self::assertNull($legacy['booking']['combinationKey']);

        // Only an explicit re-validation under the row's token changes it;
        // a stale or null token writes nothing.
        try {
            $this->api->adminMutateService([
                'action' => 'validateCombination',
                'serviceKeys' => ['brows', 'lips'],
                'durationMinutes' => 105,
                'expectedUpdatedAt' => null,
            ]);
            self::fail('a null token overwrote a stored combination');
        } catch (BookableServiceRevisionConflictException) {
            // expected
        }

        // Clearing the custom duration returns the membership to the sum,
        // and stops publishing it as an exception at all.
        $this->clock->advanceSeconds(1);
        $cleared = $this->api->adminMutateService([
            'action' => 'validateCombination',
            'serviceKeys' => ['brows', 'lips'],
            'durationMinutes' => null,
            'expectedUpdatedAt' => $byKey['brows+lips']['updatedAt'],
        ]);
        self::assertSame('default', $cleared['combination']['status']);
        self::assertNull($cleared['combination']['durationMinutes']);
        self::assertSame(105, $cleared['combination']['effectiveDurationMinutes']);
        self::assertTrue($cleared['combination']['bookable']);
        self::assertSame([], $this->api->services()['combinations']);
        $back = $this->api->availability([
            'serviceKeys' => ['brows', 'lips'],
            'fromDate' => '2026-06-22',
            'untilDate' => '2026-06-22',
        ]);
        self::assertNotSame([], $back['slots']);
        self::assertSame(
            105 * 60,
            strtotime($back['slots'][0]['endsAtUtc']) - strtotime($back['slots'][0]['startsAtUtc']),
        );
    }

    // --- Proof 2: the maximum, the disabling exception and the members ---------

    public function testSelectionIsBoundedByTheMaximumAndOnlyRefusedByAnExplicitException(): void
    {
        // Default maximum of one: two keys are refused before any lookup.
        $this->assertRefused(['brows', 'lips'], 'More services');

        $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 2]);
        // Raising the maximum is the whole configuration: the pair is now
        // bookable with nothing stored for it.
        $booking = $this->api->create($this->publicBookingRequest(['brows', 'lips'], '2026-06-15T07:15:00.000Z'));
        self::assertSame('brows+lips', $booking['combinationKey']);
        // A duplicate is not a combination, nor is a key above the limit.
        $this->assertRefused(['brows', 'brows'], 'more than once');
        try {
            $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 5]);
            self::fail('the maximum exceeded the absolute limit');
        } catch (BookingValidationException) {
            // expected
        }

        // Lowering the maximum closes the combination again.
        $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 1]);
        $this->assertRefused(['brows', 'lips'], 'More services');
        $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 2]);

        // Disabling names the membership, because it has no row to name.
        $this->clock->advanceSeconds(1);
        $disabled = $this->api->adminMutateService([
            'action' => 'disableCombination',
            'serviceKeys' => ['lips', 'brows'],
            'expectedUpdatedAt' => null,
        ]);
        self::assertSame('disabled', $disabled['combination']['status']);
        self::assertFalse($disabled['combination']['bookable']);
        self::assertNull($disabled['combination']['durationMinutes']);
        // Availability and creation refuse it in the same words, in any order.
        $this->assertRefused(['brows', 'lips'], 'not bookable');
        $this->assertRefused(['lips', 'brows'], 'not bookable');
        // The public catalogue publishes it as the exception it is, so the
        // selector can refuse it before the visitor gets to the slots.
        self::assertSame(
            [[
                'key' => 'brows+lips',
                'serviceKeys' => ['brows', 'lips'],
                'durationMinutes' => null,
                'bookable' => false,
            ]],
            $this->api->services()['combinations'],
        );

        // Re-enabling is token-protected and returns it to the default policy.
        try {
            $this->api->adminMutateService([
                'action' => 'enableCombination',
                'key' => 'brows+lips',
                'expectedUpdatedAt' => '2026-06-13T12:00:00.000Z',
            ]);
            self::fail('a stale token re-enabled a combination');
        } catch (BookableServiceRevisionConflictException) {
            // expected
        }
        $this->clock->advanceSeconds(1);
        $enabled = $this->api->adminMutateService([
            'action' => 'enableCombination',
            'key' => 'brows+lips',
            'expectedUpdatedAt' => $disabled['combination']['updatedAt'],
        ]);
        self::assertSame('default', $enabled['combination']['status']);
        self::assertTrue($enabled['combination']['bookable']);
        self::assertSame(90, $enabled['combination']['effectiveDurationMinutes']);
        self::assertSame([], $this->api->services()['combinations']);

        // The pre-ESZ-150-correction shape — a row disabled *while carrying a
        // validated duration*, which is exactly what the migration leaves
        // behind for Esther's existing `Eye-liner + Lèvres` exception — stays
        // unavailable and is never silently re-enabled by the new rule.
        $this->clock->advanceSeconds(1);
        $pinned = $this->api->adminMutateService([
            'action' => 'validateCombination',
            'serviceKeys' => ['brows', 'lips'],
            'durationMinutes' => 80,
            'expectedUpdatedAt' => $enabled['combination']['updatedAt'],
        ]);
        $this->clock->advanceSeconds(1);
        $legacyShape = $this->api->adminMutateService([
            'action' => 'disableCombination',
            'serviceKeys' => ['brows', 'lips'],
            'expectedUpdatedAt' => $pinned['combination']['updatedAt'],
        ]);
        self::assertSame('disabled', $legacyShape['combination']['status']);
        self::assertSame(80, $legacyShape['combination']['durationMinutes']);
        self::assertFalse($legacyShape['combination']['bookable']);
        $this->assertRefused(['brows', 'lips'], 'not bookable');
        // Re-enabling it keeps the duration Esther had validated.
        $this->clock->advanceSeconds(1);
        $restored = $this->api->adminMutateService([
            'action' => 'enableCombination',
            'key' => 'brows+lips',
            'expectedUpdatedAt' => $legacyShape['combination']['updatedAt'],
        ]);
        self::assertSame('validated', $restored['combination']['status']);
        self::assertSame(80, $restored['combination']['effectiveDurationMinutes']);
        // …and clearing it returns the membership to the default policy.
        $this->clock->advanceSeconds(1);
        $this->api->adminMutateService([
            'action' => 'validateCombination',
            'serviceKeys' => ['brows', 'lips'],
            'durationMinutes' => null,
            'expectedUpdatedAt' => $restored['combination']['updatedAt'],
        ]);

        // Archiving a member removes it from new bookings only.
        $lips = $this->services->find('lips');
        self::assertNotNull($lips);
        $this->services->setActive('lips', $lips->updatedAt, false);
        $this->assertRefused(['brows', 'lips'], 'not actively bookable');
        self::assertSame([], $this->api->services()['combinations']);
        $admin = $this->api->adminServices();
        self::assertSame(['brows+lips'], array_column($admin['combinations'], 'key'));
        self::assertFalse($admin['combinations'][0]['bookable']);
        // The historical combination booking keeps every stored fact and
        // the summary names all its services.
        $detail = $this->api->adminQuery(['mode' => 'reference', 'reference' => $booking['reference']]);
        self::assertSame('brows+lips', $detail['booking']['combinationKey']);
        self::assertSame(['brows', 'lips'], $detail['booking']['serviceKeys']);
        self::assertSame('2026-06-15T08:45:00.000Z', $detail['booking']['endsAtUtc']);
        $summary = $this->api->adminSummary(['upcomingDays' => 7]);
        self::assertSame([['brows', 'lips']], array_column($summary['upcoming'], 'serviceKeys'));
        // An admin move of that booking fails closed while a member is archived…
        try {
            $this->api->adminMoveAvailability([
                'reference' => $booking['reference'],
                'fromDate' => '2026-06-22',
                'untilDate' => '2026-06-22',
            ]);
            self::fail('a combination with an archived member offered move slots');
        } catch (BookingValidationException) {
            // expected
        }
        // …and restoring the member brings the combination back untouched.
        $lips = $this->services->find('lips');
        self::assertNotNull($lips);
        $this->services->setActive('lips', $lips->updatedAt, true);
        self::assertTrue($this->api->adminServices()['combinations'][0]['bookable']);

        // With three active services and a maximum of two, every pair is
        // listed and every one of them is already bookable.
        $this->services->provision('freckles', 'Taches de rousseur', 20, 0, 0, true);
        $admin = $this->api->adminServices();
        self::assertSame(
            ['brows+lips', 'brows+freckles', 'freckles+lips'],
            array_column($admin['combinations'], 'key'),
        );
        self::assertSame(['default', 'default', 'default'], array_column($admin['combinations'], 'status'));
        self::assertSame([true, true, true], array_column($admin['combinations'], 'bookable'));
        self::assertSame(50, $admin['combinations'][1]['proposedDurationMinutes']);
        self::assertSame(50, $admin['combinations'][1]['effectiveDurationMinutes']);
        self::assertNull($admin['combinations'][1]['durationMinutes']);
        self::assertNull($admin['combinations'][1]['updatedAt']);
        self::assertTrue($admin['combinationsComplete']);
    }

    /** @param list<string> $serviceKeys */
    private function assertRefused(array $serviceKeys, string $reason): void
    {
        try {
            $this->api->availability([
                'serviceKeys' => $serviceKeys,
                'fromDate' => '2026-06-15',
                'untilDate' => '2026-06-15',
            ]);
            self::fail('availability was computed for a refused selection');
        } catch (BookingValidationException $exception) {
            self::assertStringContainsString($reason, $exception->getMessage());
        }
        try {
            $this->api->create($this->publicBookingRequest($serviceKeys, '2026-06-15T07:00:00.000Z'));
            self::fail('a booking was created for a refused selection');
        } catch (BookingValidationException $exception) {
            self::assertStringContainsString($reason, $exception->getMessage());
        }
    }

    /**
     * @param list<string> $serviceKeys
     * @return array<string, mixed>
     */
    private function publicBookingRequest(array $serviceKeys, string $startsAtUtc): array
    {
        return [
            'serviceKeys' => $serviceKeys,
            'startsAtUtc' => $startsAtUtc,
            'customerName' => 'Cliente Exemple',
            'customerEmail' => 'cliente@example.test',
            'customerPhone' => null,
            'customerNote' => null,
            'privacyNoticeId' => $this->contract->currentPrivacyNoticeId,
        ];
    }
}
