<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Booking\AvailabilityRepository;
use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingRepository;
use Eszter\Booking\BookingSerializationLock;
use Eszter\Booking\BookingStateMachine;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\PdoBookingApi;
use Eszter\Booking\SlotUnavailableException;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Notification\NotificationPolicy;
use Eszter\Tests\MovableClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-153 — a confirmed booking owns the facts that fix its effective
 * interval, against the disposable MySQL.
 *
 * What is proved, each as its own test:
 *
 *  - a catalog edit after confirmation (duration and both buffers) reshapes
 *    new slots and leaves the confirmed booking's occupied interval exactly
 *    where it was;
 *  - the existing overlap prevention still refuses a conflicting confirmation
 *    against the snapshotted interval;
 *  - a permitted move keeps the booking's stored services, its stored
 *    duration and its buffer snapshot, and takes nothing from the catalog as
 *    it is configured later.
 */
final class BookingSnapshotSqlTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const MONDAY = '2026-06-15';

    private static bool $migrated = false;

    private \Eszter\Database\Database $database;
    private MovableClock $clock;
    private BookingDomainContract $contract;
    private BookableServiceRepository $services;
    private BookingRepository $bookings;
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
        $this->bookings = new BookingRepository(
            $this->database,
            $this->clock,
            $this->contract,
            new BookingTimePolicy($this->contract),
            $this->services,
            new BookingStateMachine($this->contract),
        );
        $availability = new AvailabilityRepository(
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

        // Mondays 09:00–13:00 local (07:00–11:00 UTC in June).
        $availability->replaceWeeklyRules($availability->revision(), [new WeeklyAvailabilityRule(
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

    // --- Proof 1: a later catalog edit never changes an occupied interval ---

    public function testChangingCatalogDurationAndBuffersAfterConfirmationLeavesTheOccupiedIntervalAlone(): void
    {
        $this->services->provision('brows', 'Sourcils', 30, 0, 0, true);
        $booking = $this->api->create($this->publicBookingRequest('2026-06-15T07:00:00.000Z'));
        self::assertSame('2026-06-15T07:30:00.000Z', $booking['endsAtUtc']);
        self::assertSame(
            ['buffer_before_minutes' => 0, 'buffer_after_minutes' => 0, 'origin' => 'offer'],
            $this->snapshotOf($booking['reference']),
        );
        self::assertSame([['2026-06-15 07:00:00', '2026-06-15 07:30:00']], $this->occupiedOnMonday());

        // The catalog moves on: 45 minutes with 30-minute buffers each side.
        $this->clock->advanceSeconds(1);
        $this->services->provision('brows', 'Sourcils', 45, 30, 30, true);

        // The confirmed booking blocks exactly what it blocked before, and
        // its own rows are untouched.
        self::assertSame([['2026-06-15 07:00:00', '2026-06-15 07:30:00']], $this->occupiedOnMonday());
        self::assertSame(
            ['buffer_before_minutes' => 0, 'buffer_after_minutes' => 0, 'origin' => 'offer'],
            $this->snapshotOf($booking['reference']),
        );
        $detail = $this->api->adminQuery(['mode' => 'reference', 'reference' => $booking['reference']]);
        self::assertSame('2026-06-15T07:30:00.000Z', $detail['booking']['endsAtUtc']);

        // New slots use the current catalog: 45 minutes, and the first one
        // must place its 30-minute before-buffer after the old booking's end
        // and inside the window — 08:00Z (10:00 local), never earlier.
        $slots = $this->api->availability([
            'serviceKey' => 'brows',
            'fromDate' => self::MONDAY,
            'untilDate' => self::MONDAY,
        ])['slots'];
        self::assertNotSame([], $slots);
        self::assertSame('2026-06-15T08:00:00.000Z', $slots[0]['startsAtUtc']);
        self::assertSame('2026-06-15T08:45:00.000Z', $slots[0]['endsAtUtc']);

        // And a booking confirmed now captures the current offer's buffers
        // as its own snapshot — independent of the first booking's.
        $later = $this->api->create($this->publicBookingRequest('2026-06-15T08:00:00.000Z'));
        self::assertSame(
            ['buffer_before_minutes' => 30, 'buffer_after_minutes' => 30, 'origin' => 'offer'],
            $this->snapshotOf($later['reference']),
        );
        self::assertSame(
            [['2026-06-15 07:00:00', '2026-06-15 07:30:00'], ['2026-06-15 07:30:00', '2026-06-15 09:15:00']],
            $this->occupiedOnMonday(),
        );
    }

    // --- Proof 2: overlap prevention still holds against the snapshot -------

    public function testAConflictingConfirmationIsStillRefusedAgainstTheSnapshottedInterval(): void
    {
        $this->services->provision('brows', 'Sourcils', 30, 15, 15, true);
        $booking = $this->api->create($this->publicBookingRequest('2026-06-15T08:00:00.000Z'));
        self::assertSame([['2026-06-15 07:45:00', '2026-06-15 08:45:00']], $this->occupiedOnMonday());

        // Shrinking the catalog's buffers to nothing does not shrink what the
        // confirmed booking blocks: a start whose own interval would land in
        // the snapshotted buffer is refused under the serialization boundary.
        $this->clock->advanceSeconds(1);
        $this->services->provision('brows', 'Sourcils', 30, 0, 0, true);
        foreach (['2026-06-15T08:15:00.000Z', '2026-06-15T07:30:00.000Z', '2026-06-15T08:30:00.000Z'] as $conflicting) {
            try {
                $this->api->create($this->publicBookingRequest($conflicting));
                self::fail("a booking at {$conflicting} was confirmed over a snapshotted interval");
            } catch (SlotUnavailableException) {
                // expected
            }
        }
        self::assertSame(1, (int) ($this->database->fetchOne(
            "SELECT COUNT(*) AS n FROM bookings WHERE state = 'confirmed'",
        )['n'] ?? 0));

        // The first instant clear of the snapshotted after-buffer is bookable.
        $next = $this->api->create($this->publicBookingRequest('2026-06-15T08:45:00.000Z'));
        self::assertNotSame($booking['reference'], $next['reference']);
    }

    // --- Proof 3: a move keeps the snapshot ---------------------------------

    public function testAPermittedMovePreservesTheStoredServicesDurationAndBufferSnapshot(): void
    {
        $this->services->provision('brows', 'Sourcils', 30, 5, 10, true);
        $booking = $this->api->create($this->publicBookingRequest('2026-06-15T07:15:00.000Z'));
        self::assertSame('2026-06-15T07:45:00.000Z', $booking['endsAtUtc']);

        // The catalog then doubles the duration and drops the buffers.
        $this->clock->advanceSeconds(1);
        $this->services->provision('brows', 'Sourcils', 60, 0, 0, true);

        // The move read offers 30-minute slots for this booking, shaped by
        // its own 5/10 buffers: 09:00 local (07:00Z) cannot host the
        // 5-minute before-buffer inside the window, so the first slot is
        // 09:15 local.
        $moveSlots = $this->api->adminMoveAvailability([
            'reference' => $booking['reference'],
            'fromDate' => self::MONDAY,
            'untilDate' => self::MONDAY,
        ])['slots'];
        self::assertNotSame([], $moveSlots);
        self::assertSame('2026-06-15T07:15:00.000Z', $moveSlots[0]['startsAtUtc']);
        foreach ($moveSlots as $slot) {
            self::assertSame(30 * 60, strtotime($slot['endsAtUtc']) - strtotime($slot['startsAtUtc']));
        }

        $detail = $this->api->adminQuery(['mode' => 'reference', 'reference' => $booking['reference']]);
        $token = $detail['booking']['updatedAt'];
        $this->clock->advanceSeconds(1);
        $moved = $this->api->adminMutate([
            'action' => 'move',
            'reference' => $booking['reference'],
            'expectedUpdatedAt' => $token,
            'startsAtUtc' => '2026-06-15T09:00:00.000Z',
        ])['booking'];

        // Same services, same 30-minute duration, same snapshot; only the
        // instant moved, and the occupied interval moved with it.
        self::assertSame(['brows'], $moved['serviceKeys']);
        self::assertSame('2026-06-15T09:00:00.000Z', $moved['startsAtUtc']);
        self::assertSame('2026-06-15T09:30:00.000Z', $moved['endsAtUtc']);
        self::assertSame(
            ['buffer_before_minutes' => 5, 'buffer_after_minutes' => 10, 'origin' => 'offer'],
            $this->snapshotOf($booking['reference']),
        );
        self::assertSame([['2026-06-15 08:55:00', '2026-06-15 09:40:00']], $this->occupiedOnMonday());
        self::assertSame(1, (int) ($this->database->fetchOne(
            'SELECT COUNT(*) AS n FROM booking_buffer_snapshots',
        )['n'] ?? 0));
    }

    // --- helpers -------------------------------------------------------------

    /** @return array<string, mixed> */
    private function publicBookingRequest(string $startsAtUtc): array
    {
        return [
            'serviceKey' => 'brows',
            'startsAtUtc' => $startsAtUtc,
            'customerName' => 'Cliente Exemple',
            'customerEmail' => 'cliente@example.test',
            'customerPhone' => null,
            'customerNote' => null,
            'privacyNoticeId' => $this->contract->currentPrivacyNoticeId,
        ];
    }

    /** @return array<string, mixed>|null */
    private function snapshotOf(string $reference): ?array
    {
        return $this->database->fetchOne(
            'SELECT ss.buffer_before_minutes, ss.buffer_after_minutes, ss.origin'
            . ' FROM booking_buffer_snapshots ss INNER JOIN bookings b ON b.id = ss.booking_id'
            . ' WHERE b.reference = :reference',
            ['reference' => $reference],
        );
    }

    /**
     * The Monday's occupied intervals as the repository reports them, as
     * `[start, end]` UTC pairs.
     *
     * @return list<array{string, string}>
     */
    private function occupiedOnMonday(): array
    {
        $rows = [];
        foreach (
            $this->bookings->occupiedBetween(
                new \DateTimeImmutable('2026-06-14T22:00:00Z'),
                new \DateTimeImmutable('2026-06-15T22:00:00Z'),
            ) as $interval
        ) {
            $rows[] = [
                $interval->startsAtUtc->format('Y-m-d H:i:s'),
                $interval->endsAtUtc->format('Y-m-d H:i:s'),
            ];
        }

        return $rows;
    }
}
