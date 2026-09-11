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
 * MySQL.
 *
 * What is proved, each as its own test:
 *
 *  - the persisted validated duration is the authority for availability and
 *    creation of a combination, the proposal is the plain sum and advisory,
 *    and a later component-duration edit moves the proposal without
 *    rewriting the validated duration or any stored booking;
 *  - the configured maximum bounds public selection: the default is one,
 *    a selection above the maximum is refused, an unvalidated or disabled
 *    combination is refused, and archiving a member disables the
 *    combination for new bookings while the historical booking keeps its
 *    stored facts;
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

    // --- Proof 1: the validated duration is the authority ---------------------

    public function testTheValidatedDurationShapesSlotsAndBookingsAndSurvivesComponentEdits(): void
    {
        // A single-service booking made before any combination exists.
        // (09:15 local: the 5-minute before-buffer cannot precede the window.)
        $single = $this->api->create($this->publicBookingRequest(['brows'], '2026-06-15T07:15:00.000Z'));
        self::assertSame(['brows'], $single['serviceKeys']);
        self::assertNull($single['combinationKey']);

        // The proposal is the plain sum (90); Esther validates 75 for B+A —
        // stored under the canonical key, buffers snapshotted as the maxima.
        $this->clock->advanceSeconds(1);
        $validated = $this->api->adminMutateService([
            'action' => 'validateCombination',
            'serviceKeys' => ['lips', 'brows'],
            'durationMinutes' => 75,
            'expectedUpdatedAt' => null,
        ]);
        self::assertSame('brows+lips', $validated['combination']['key']);
        self::assertSame(['brows', 'lips'], $validated['combination']['serviceKeys']);
        self::assertSame(90, $validated['combination']['proposedDurationMinutes']);
        self::assertSame(75, $validated['combination']['durationMinutes']);
        self::assertSame('validated', $validated['combination']['status']);
        // Not yet bookable: the maximum is still the default of one.
        self::assertFalse($validated['combination']['bookable']);
        self::assertSame(1, $this->api->services()['maxServicesPerAppointment']);
        self::assertSame([], $this->api->services()['combinations']);

        $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 2]);
        $public = $this->api->services();
        self::assertSame(2, $public['maxServicesPerAppointment']);
        self::assertSame(
            [['key' => 'brows+lips', 'serviceKeys' => ['brows', 'lips'], 'durationMinutes' => 75]],
            $public['combinations'],
        );

        // Availability uses 75 minutes — not 90 — and the snapshotted buffers
        // (5 before, 10 after): the single booking occupies [07:10, 07:45)
        // UTC with brows' own buffer, so the first combination slot must
        // clear it and end 75 minutes after its start.
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
            self::assertSame(75 * 60, strtotime($slot['endsAtUtc']) - strtotime($slot['startsAtUtc']));
        }
        // 08:00 UTC (10:00 local): resource [07:55, 09:25) fits the window
        // and clears the single booking; 07:45 would start its buffer inside it.
        self::assertSame('2026-06-15T08:00:00.000Z', $slots['slots'][0]['startsAtUtc']);
        self::assertSame('2026-06-15T09:15:00.000Z', $slots['slots'][0]['endsAtUtc']);

        // Creation stores the first member, the combination key and the
        // 75-minute interval the validated duration produced.
        $booking = $this->api->create($this->publicBookingRequest(['lips', 'brows'], '2026-06-15T08:00:00.000Z'));
        self::assertSame('brows', $booking['serviceKey']);
        self::assertSame(['brows', 'lips'], $booking['serviceKeys']);
        self::assertSame('brows+lips', $booking['combinationKey']);
        self::assertSame('2026-06-15T09:15:00.000Z', $booking['endsAtUtc']);
        $row = $this->database->fetchOne(
            'SELECT service_key, combination_key FROM bookings WHERE reference = :reference',
            ['reference' => $booking['reference']],
        );
        self::assertSame(['service_key' => 'brows', 'combination_key' => 'brows+lips'], $row);

        // A component edit moves the proposal and nothing else: the
        // validated duration, the slots and the stored bookings stand.
        $this->clock->advanceSeconds(1);
        $brows = $this->services->find('brows');
        self::assertNotNull($brows);
        $this->services->update('brows', $brows->updatedAt, 'Sourcils', '', 45, null);
        $admin = $this->api->adminServices();
        self::assertSame(2, $admin['maxServicesPerAppointment']);
        self::assertTrue($admin['combinationsComplete']);
        self::assertCount(1, $admin['combinations']);
        self::assertSame(105, $admin['combinations'][0]['proposedDurationMinutes']);
        self::assertSame(75, $admin['combinations'][0]['durationMinutes']);
        self::assertTrue($admin['combinations'][0]['bookable']);
        $after = $this->api->availability([
            'serviceKeys' => ['brows', 'lips'],
            'fromDate' => '2026-06-22',
            'untilDate' => '2026-06-22',
        ]);
        // 09:00 local cannot host the 5-minute before-buffer inside the
        // window, so the first slot is 09:15 local, still 75 minutes long.
        self::assertSame('2026-06-22T07:15:00.000Z', $after['slots'][0]['startsAtUtc']);
        self::assertSame('2026-06-22T08:30:00.000Z', $after['slots'][0]['endsAtUtc']);
        $detail = $this->api->adminQuery(['mode' => 'reference', 'reference' => $booking['reference']]);
        self::assertSame('2026-06-15T09:15:00.000Z', $detail['booking']['endsAtUtc']);
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
        $revalidated = $this->api->adminMutateService([
            'action' => 'validateCombination',
            'serviceKeys' => ['brows', 'lips'],
            'durationMinutes' => 105,
            'expectedUpdatedAt' => $admin['combinations'][0]['updatedAt'],
        ]);
        self::assertSame(105, $revalidated['combination']['durationMinutes']);
        self::assertSame(105, $revalidated['combination']['proposedDurationMinutes']);
    }

    // --- Proof 2: the maximum, the approval and the members bound bookability --

    public function testSelectionIsBoundedByTheMaximumAndByAnApprovedActiveCombination(): void
    {
        // Default maximum of one: two keys are refused before any lookup.
        $this->assertRefused(['brows', 'lips'], 'More services');

        $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 2]);
        // No implicit combination.
        $this->assertRefused(['brows', 'lips'], 'not bookable');
        // A duplicate is not a combination, nor is a key above the limit.
        $this->assertRefused(['brows', 'brows'], 'more than once');
        try {
            $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 5]);
            self::fail('the maximum exceeded the absolute limit');
        } catch (BookingValidationException) {
            // expected
        }

        $validated = $this->api->adminMutateService([
            'action' => 'validateCombination',
            'serviceKeys' => ['brows', 'lips'],
            'durationMinutes' => 75,
            'expectedUpdatedAt' => null,
        ]);
        $booking = $this->api->create($this->publicBookingRequest(['brows', 'lips'], '2026-06-15T07:15:00.000Z'));

        // Lowering the maximum closes the combination without touching it.
        $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 1]);
        $this->assertRefused(['brows', 'lips'], 'More services');
        self::assertSame([], $this->api->services()['combinations']);
        self::assertFalse($this->api->adminServices()['combinations'][0]['bookable']);
        $this->api->adminMutateService(['action' => 'setMaxServices', 'maxServicesPerAppointment' => 2]);

        // Disabling is explicit, token-protected and reversible.
        $disabled = $this->api->adminMutateService([
            'action' => 'disableCombination',
            'key' => 'brows+lips',
            'expectedUpdatedAt' => $validated['combination']['updatedAt'],
        ]);
        self::assertSame('disabled', $disabled['combination']['status']);
        $this->assertRefused(['brows', 'lips'], 'not bookable');
        try {
            $this->api->adminMutateService([
                'action' => 'enableCombination',
                'key' => 'brows+lips',
                'expectedUpdatedAt' => $validated['combination']['updatedAt'],
            ]);
            self::fail('a stale token re-enabled a combination');
        } catch (BookableServiceRevisionConflictException) {
            // expected
        }
        $enabled = $this->api->adminMutateService([
            'action' => 'enableCombination',
            'key' => 'brows+lips',
            'expectedUpdatedAt' => $disabled['combination']['updatedAt'],
        ]);
        self::assertTrue($enabled['combination']['bookable']);

        // Archiving a member disables the combination for new bookings only.
        $lips = $this->services->find('lips');
        self::assertNotNull($lips);
        $this->services->setActive('lips', $lips->updatedAt, false);
        $this->assertRefused(['brows', 'lips'], 'not actively bookable');
        self::assertSame([], $this->api->services()['combinations']);
        $admin = $this->api->adminServices();
        self::assertSame('validated', $admin['combinations'][0]['status']);
        self::assertFalse($admin['combinations'][0]['bookable']);
        // The historical combination booking keeps every stored fact and
        // the summary names all its services.
        $detail = $this->api->adminQuery(['mode' => 'reference', 'reference' => $booking['reference']]);
        self::assertSame('brows+lips', $detail['booking']['combinationKey']);
        self::assertSame(['brows', 'lips'], $detail['booking']['serviceKeys']);
        self::assertSame('2026-06-15T08:30:00.000Z', $detail['booking']['endsAtUtc']);
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
        self::assertSame(['brows+lips'], array_column($this->api->services()['combinations'], 'key'));
        self::assertSame(75, $this->api->services()['combinations'][0]['durationMinutes']);

        // Candidates: with three active services and a maximum of two, the
        // two unstored pairs are proposed with their sums and no token.
        $this->services->provision('freckles', 'Taches de rousseur', 20, 0, 0, true);
        $admin = $this->api->adminServices();
        self::assertSame(
            ['brows+lips', 'brows+freckles', 'freckles+lips'],
            array_column($admin['combinations'], 'key'),
        );
        self::assertSame(['validated', 'proposed', 'proposed'], array_column($admin['combinations'], 'status'));
        self::assertSame(50, $admin['combinations'][1]['proposedDurationMinutes']);
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
