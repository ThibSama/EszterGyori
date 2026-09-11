<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingNotFoundException;
use Eszter\Booking\BookingRepository;
use Eszter\Booking\BookingSerializationLock;
use Eszter\Booking\BookingStateMachine;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Database\Database;
use Eszter\Privacy\InvalidPrivacyRequestTransitionException;
use Eszter\Privacy\PrivacyRequestAdministration;
use Eszter\Privacy\PrivacyRequestRepository;
use Eszter\Privacy\PrivacyRequestRetention;
use Eszter\Retention\RetentionPolicy;
use Eszter\Tests\MovableClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-163 — the GDPR request register against the disposable MySQL.
 *
 * What is proved, each as its own test:
 *
 *  - identification resolves one booking by current or legacy reference and
 *    the live bookings of an e-mail case-insensitively, paginated with the
 *    completeness on the wire, never through the erased placeholder;
 *  - recording stores exactly the selected references, refuses an unknown or
 *    erased one and a duplicate, derives the one-month deadline, and writes
 *    nothing about the requester or the customer;
 *  - the lifecycle is the straight line received → in_progress → closed,
 *    the closure instant lands with the status, and history reads all three;
 *  - the three-year purge removes only closed records whose closure is old
 *    enough, and never an open one.
 */
final class PrivacyRequestSqlTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const LEGACY = 'bk_0123456789abcdef0123456789abcdef';

    private static bool $migrated = false;

    private Database $database;
    private MovableClock $clock;
    private BookingDomainContract $contract;
    private BookingRepository $bookings;
    private PrivacyRequestRepository $requests;
    private PrivacyRequestAdministration $admin;
    private RetentionPolicy $retention;

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
        $artifacts = TestEnvironment::artifacts();
        $this->contract = BookingDomainContract::fromArtifacts($artifacts);
        $this->retention = RetentionPolicy::fromArtifacts($artifacts);
        $time = new BookingTimePolicy($this->contract);
        $services = new BookableServiceRepository(
            $this->database,
            $this->clock,
            $this->contract,
            new BookingSerializationLock($this->database),
        );
        $this->bookings = new BookingRepository(
            $this->database,
            $this->clock,
            $this->contract,
            $time,
            $services,
            new BookingStateMachine($this->contract),
        );
        $this->requests = new PrivacyRequestRepository(
            $this->database,
            $this->clock,
            $this->contract->privacyRequests,
        );
        $this->admin = new PrivacyRequestAdministration(
            $this->contract->privacyRequests,
            $this->requests,
            $this->bookings,
            $time,
        );

        $services->provision('brows', 'Sourcils', 30, 0, 0, true);

        $this->database->beginTransaction();
    }

    protected function tearDown(): void
    {
        if (isset($this->database) && $this->database->inTransaction()) {
            $this->database->rollBack();
        }
    }

    // --- Identification -----------------------------------------------------

    public function testAReferenceOfEitherShapeResolvesExactlyOneLiveBooking(): void
    {
        $current = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');
        $this->insertBooking('2026-06-22 07:00:00.000', 'cliente@example.test', self::LEGACY);

        foreach ([$current, self::LEGACY] as $reference) {
            $result = $this->admin->adminPrivacyRequestSearch(['mode' => 'reference', 'reference' => $reference]);
            self::assertCount(1, $result['matches']);
            self::assertSame($reference, $result['matches'][0]['reference']);
            self::assertSame('Cliente Exemple', $result['matches'][0]['customerName']);
            self::assertFalse($result['page']['hasMore']);
            // The match carries what the scope review needs — never the
            // e-mail, phone or note the register must not hold.
            self::assertSame(
                ['reference', 'serviceKeys', 'state', 'startsAtUtc', 'endsAtUtc', 'customerName'],
                array_keys($result['matches'][0]),
            );
        }

        $this->expectException(BookingNotFoundException::class);
        $this->admin->adminPrivacyRequestSearch(['mode' => 'reference', 'reference' => 'bk_ffffffffffffffffffffffffffffffff']);
    }

    public function testAnErasedBookingIsNotIdentifiableByReferenceEither(): void
    {
        $reference = $this->insertBooking('2026-01-05 08:00:00.000', 'ancienne@example.test');
        $this->erase($reference);

        $this->expectException(BookingNotFoundException::class);
        $this->admin->adminPrivacyRequestSearch(['mode' => 'reference', 'reference' => $reference]);
    }

    public function testAnEmailLookupIsCaseInsensitivePaginatedAndCompleteOnTheWire(): void
    {
        $pageSize = $this->contract->privacyRequests->searchPageSize;
        $expected = [];
        for ($i = 0; $i < $pageSize + 1; ++$i) {
            $start = (new \DateTimeImmutable('2026-06-15 07:00:00', new \DateTimeZone('UTC')))
                ->modify('+' . $i . ' days')
                ->format('Y-m-d H:i:s.v');
            $expected[] = $this->insertBooking($start, $i % 2 === 0 ? 'Shared@Example.test' : 'shared@example.test');
        }
        // Another customer's booking is never in the answer.
        $this->insertBooking('2026-06-15 09:00:00.000', 'autre@example.test');

        $first = $this->admin->adminPrivacyRequestSearch(['mode' => 'email', 'email' => 'SHARED@example.test']);
        self::assertCount($pageSize, $first['matches']);
        self::assertTrue($first['page']['hasMore'], 'the surplus match must be announced, never dropped');
        self::assertNotNull($first['page']['nextCursor']);

        $second = $this->admin->adminPrivacyRequestSearch([
            'mode' => 'email',
            'email' => 'shared@example.test',
            'cursor' => $first['page']['nextCursor'],
        ]);
        self::assertCount(1, $second['matches']);
        self::assertFalse($second['page']['hasMore']);
        self::assertNull($second['page']['nextCursor']);

        $walked = array_merge(
            array_column($first['matches'], 'reference'),
            array_column($second['matches'], 'reference'),
        );
        self::assertSame($expected, $walked, 'the walk covers every booking once, in start order');
    }

    public function testTheErasedPlaceholderNeverReconnectsAnonymisedBookings(): void
    {
        $one = $this->insertBooking('2026-01-05 08:00:00.000', 'une@example.test');
        $two = $this->insertBooking('2026-01-12 08:00:00.000', 'deux@example.test');
        $this->erase($one);
        $this->erase($two);
        $live = $this->insertBooking('2026-06-15 07:00:00.000', 'deux@example.test');

        // Both erased rows now carry the identical placeholder address.
        self::assertSame(2, $this->rowCount(
            'SELECT COUNT(*) AS n FROM bookings WHERE customer_email = :email',
            ['email' => $this->retention->erasedCustomerEmail],
        ));

        $placeholder = $this->admin->adminPrivacyRequestSearch(['mode' => 'email', 'email' => $this->retention->erasedCustomerEmail]);
        self::assertSame([], $placeholder['matches']);
        self::assertFalse($placeholder['page']['hasMore']);

        // And the customer's own address finds only the booking that is
        // still theirs.
        $byEmail = $this->admin->adminPrivacyRequestSearch(['mode' => 'email', 'email' => 'deux@example.test']);
        self::assertSame([$live], array_column($byEmail['matches'], 'reference'));
    }

    // --- Recording the reviewed scope ---------------------------------------

    public function testRecordingStoresExactlyTheSelectedReferencesAndNothingAboutTheRequester(): void
    {
        $a = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');
        $b = $this->insertBooking('2026-06-22 07:00:00.000', 'cliente@example.test');
        $c = $this->insertBooking('2026-06-29 07:00:00.000', 'cliente@example.test');

        // Three bookings share the address; the administrator selects two.
        // A shared e-mail never implies "all bookings".
        $recorded = $this->admin->adminRecordPrivacyRequest([
            'type' => 'access',
            'receivedDate' => '2026-01-31',
            'bookingReferences' => [$c, $a],
        ])['request'];

        self::assertSame('access', $recorded['type']);
        self::assertSame('received', $recorded['status']);
        self::assertSame('2026-01-31', $recorded['receivedDate']);
        self::assertSame('2026-02-28', $recorded['deadlineDate'], 'one calendar month, clamped to the month end');
        self::assertNull($recorded['closedAtUtc']);
        self::assertSame([$c, $a], $recorded['bookingReferences'], 'selection order is kept, and b is absent');
        self::assertSame(
            ['id', 'type', 'status', 'receivedDate', 'deadlineDate', 'closedAtUtc', 'bookingReferences', 'createdAt', 'updatedAt'],
            array_keys($recorded),
        );

        // The register's columns are the whole of what was written: no
        // e-mail, message or copied customer field exists to be written.
        $columns = array_column(
            $this->database->fetchAll(
                'SELECT column_name AS name FROM information_schema.columns'
                . ' WHERE table_schema = DATABASE() AND table_name = :table ORDER BY ordinal_position',
                ['table' => 'privacy_requests'],
            ),
            'name',
        );
        self::assertSame(
            ['id', 'request_type', 'status', 'received_date', 'deadline_date', 'closed_at_utc', 'created_at', 'updated_at'],
            array_map(static fn ($column): string => (string) $column, $columns),
        );
        self::assertSame(2, $this->rowCount(
            'SELECT COUNT(*) AS n FROM privacy_request_bookings WHERE request_id = :id',
            ['id' => $recorded['id']],
        ));
        self::assertSame($b, $this->bookings->find($b)?->reference, 'no booking row changed');

        // An empty, confirmed scope is a record too.
        $empty = $this->admin->adminRecordPrivacyRequest([
            'type' => 'portability',
            'receivedDate' => '2026-06-13',
            'bookingReferences' => [],
        ])['request'];
        self::assertSame([], $empty['bookingReferences']);
        self::assertSame('2026-07-13', $empty['deadlineDate']);
    }

    public function testRecordingRefusesAnUnknownAnErasedAndADuplicateReference(): void
    {
        $live = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');
        $erased = $this->insertBooking('2026-01-05 08:00:00.000', 'ancienne@example.test');
        $this->erase($erased);

        foreach (
            [
                [BookingNotFoundException::class, ['bk_ffffffffffffffffffffffffffffffff']],
                [BookingNotFoundException::class, [$live, $erased]],
                [BookingValidationException::class, [$live, $live]],
            ] as [$exception, $references]
        ) {
            try {
                $this->admin->adminRecordPrivacyRequest(['type' => 'erasure', 'receivedDate' => '2026-06-13', 'bookingReferences' => $references]);
                self::fail('a request with ' . json_encode($references) . ' was recorded');
            } catch (BookingNotFoundException | BookingValidationException $caught) {
                self::assertInstanceOf($exception, $caught);
            }
        }
        self::assertSame(0, $this->rowCount('SELECT COUNT(*) AS n FROM privacy_requests'));

        $this->expectException(BookingValidationException::class);
        $this->admin->adminRecordPrivacyRequest(['type' => 'opposition', 'receivedDate' => '2026-06-13', 'bookingReferences' => []]);
    }

    // --- The lifecycle ------------------------------------------------------

    public function testTheLifecycleIsAutomaticAndTheClosureInstantLandsWithTheStatus(): void
    {
        $reference = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');
        $received = $this->admin->adminRecordPrivacyRequest([
            'type' => 'rectification',
            'receivedDate' => '2026-06-13',
            'bookingReferences' => [$reference],
        ])['request'];
        $id = $received['id'];
        self::assertIsInt($id);

        // Closing a request that has not started is refused: closed is
        // reached only when an action completes.
        try {
            $this->requests->close($id);
            self::fail('a received request was closed without an execution');
        } catch (InvalidPrivacyRequestTransitionException $exception) {
            self::assertSame('received', $exception->from);
        }

        $this->clock->advanceSeconds(60);
        $inProgress = $this->requests->startExecution($id);
        self::assertSame('in_progress', $inProgress->status);
        self::assertNull($inProgress->closedAtUtc);

        // Idempotence is refusal, not a silent second application.
        try {
            $this->requests->startExecution($id);
            self::fail('in_progress was applied twice');
        } catch (InvalidPrivacyRequestTransitionException) {
            // expected
        }

        $this->clock->advanceSeconds(60);
        $closed = $this->requests->close($id);
        self::assertSame('closed', $closed->status);
        self::assertSame('2026-06-13 12:02:00.000', $closed->closedAtUtc);
        self::assertSame('2026-06-13T12:02:00.000Z', $closed->payload()['closedAtUtc']);
        self::assertSame([$reference], $closed->bookingReferences);

        try {
            $this->requests->startExecution($id);
            self::fail('a closed request went backwards');
        } catch (InvalidPrivacyRequestTransitionException) {
            // expected
        }

        // The schema refuses the two facts written out of step.
        try {
            $this->database->run(
                'UPDATE privacy_requests SET closed_at_utc = NULL WHERE id = :id',
                ['id' => $id],
            );
            self::fail('a closed row lost its closure instant');
        } catch (\Eszter\Database\DatabaseException) {
            // expected: chk_privacy_requests_closure
        }
    }

    public function testHistoryReadsAllThreeStatesNewestFirstWithItsOwnPagination(): void
    {
        $reference = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');
        $ids = [];
        foreach (['access', 'erasure', 'restriction'] as $type) {
            $this->clock->advanceSeconds(1);
            $ids[] = $this->admin->adminRecordPrivacyRequest([
                'type' => $type,
                'receivedDate' => '2026-06-13',
                'bookingReferences' => [$reference],
            ])['request']['id'];
        }
        $this->requests->startExecution($ids[1]);
        $this->requests->startExecution($ids[2]);
        $this->requests->close($ids[2]);

        $history = $this->admin->adminPrivacyRequests(['mode' => 'history']);
        self::assertSame(array_reverse($ids), array_column($history['requests'], 'id'));
        self::assertSame(['closed', 'in_progress', 'received'], array_column($history['requests'], 'status'));
        self::assertSame($this->contract->privacyRequests->historyPageSize, $history['page']['pageSize']);
        self::assertFalse($history['page']['hasMore']);
        self::assertNull($history['page']['nextCursor']);
        self::assertNotNull($history['requests'][0]['closedAtUtc']);
        self::assertNull($history['requests'][1]['closedAtUtc']);

        $detail = $this->admin->adminPrivacyRequests(['mode' => 'detail', 'id' => $ids[0]]);
        self::assertSame('2026-07-13', $detail['request']['deadlineDate']);
        self::assertSame([$reference], $detail['request']['bookingReferences']);
    }

    // --- Retention ----------------------------------------------------------

    public function testOnlyClosedRecordsOlderThanThreeYearsArePurged(): void
    {
        $retention = new PrivacyRequestRetention(
            $this->requests,
            $this->clock,
            $this->contract->privacyRequests,
        );
        $reference = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');

        $record = fn (): int => $this->admin->adminRecordPrivacyRequest([
            'type' => 'access',
            'receivedDate' => '2023-06-01',
            'bookingReferences' => [$reference],
        ])['request']['id'];

        // Closed exactly three years ago: purged. Closed a second later: kept.
        $this->moveClockTo('2023-06-13T12:00:00.000Z');
        $oldClosed = $record();
        $this->requests->startExecution($oldClosed);
        $this->requests->close($oldClosed);
        $this->moveClockTo('2023-06-13T12:00:01.000Z');
        $recentClosed = $record();
        $this->requests->startExecution($recentClosed);
        $this->requests->close($recentClosed);

        // Opened three years ago and never closed: never purged.
        $this->moveClockTo('2023-01-01T00:00:00.000Z');
        $oldReceived = $record();
        $oldInProgress = $record();
        $this->requests->startExecution($oldInProgress);

        $this->moveClockTo(self::NOW);
        $result = $retention->purgeExpired();

        self::assertSame(1, $result['purged']);
        self::assertSame('2023-06-13T12:00:00.000Z', $result['cutoffUtc']);
        self::assertNull($this->requests->find($oldClosed));
        self::assertSame(0, $this->rowCount(
            'SELECT COUNT(*) AS n FROM privacy_request_bookings WHERE request_id = :id',
            ['id' => $oldClosed],
        ));
        self::assertSame('closed', $this->requests->find($recentClosed)?->status);
        self::assertSame('received', $this->requests->find($oldReceived)?->status);
        self::assertSame('in_progress', $this->requests->find($oldInProgress)?->status);

        // Purging touches no booking.
        self::assertSame($reference, $this->bookings->find($reference)?->reference);

        // A second run finds nothing left.
        self::assertSame(0, $retention->purgeExpired()['purged']);
    }

    // --- helpers -------------------------------------------------------------

    /** Inserts one confirmed booking row directly and returns its reference. */
    private function insertBooking(string $startsAtUtc, string $email, ?string $reference = null): string
    {
        $reference ??= $this->freshReference();
        $ends = (new \DateTimeImmutable($startsAtUtc, new \DateTimeZone('UTC')))
            ->modify('+30 minutes')
            ->format('Y-m-d H:i:s.v');
        $now = $this->clock->nowIso();

        $this->database->run(
            'INSERT INTO bookings (reference, service_key, combination_key, state, starts_at_utc, ends_at_utc,'
            . ' timezone_name, customer_name, customer_email, customer_phone, customer_note,'
            . ' consent_at_utc, consent_notice_id, privacy_notice_id, privacy_notice_presented_at_utc,'
            . ' created_at, updated_at, state_changed_at)'
            . ' VALUES (:reference, :service, NULL, :state, :starts, :ends, :timezone, :name, :email, NULL, NULL,'
            . ' NULL, NULL, :notice, :presented, :created, :updated, :changed)',
            [
                'reference' => $reference,
                'service' => 'brows',
                'state' => 'confirmed',
                'starts' => $startsAtUtc,
                'ends' => $ends,
                'timezone' => $this->contract->timezone,
                'name' => 'Cliente Exemple',
                'email' => $email,
                'notice' => $this->contract->currentPrivacyNoticeId,
                'presented' => '2026-06-13 12:00:00.000',
                'created' => $now,
                'updated' => $now,
                'changed' => $now,
            ],
        );

        return $reference;
    }

    private int $sequence = 0;

    /** A current-shape reference, distinct per call and byte-ordered by call. */
    private function freshReference(): string
    {
        $alphabet = $this->contract->referenceAlphabet;
        $n = $this->sequence++;
        $digits = '';
        for ($i = 0; $i < 8; ++$i) {
            $digits = $alphabet[$n % \strlen($alphabet)] . $digits;
            $n = intdiv($n, \strlen($alphabet));
        }

        return substr($digits, 0, 4) . '-' . substr($digits, 4);
    }

    /** Anonymises a booking the way the ESZ-140 sweep does. */
    private function erase(string $reference): void
    {
        $this->database->run(
            'UPDATE bookings SET customer_name = :name, customer_email = :email,'
            . ' customer_phone = NULL, customer_note = NULL, cancellation_reason = NULL,'
            . ' customer_data_erased_at = :marker WHERE reference = :reference',
            [
                'name' => $this->retention->erasedCustomerName,
                'email' => $this->retention->erasedCustomerEmail,
                'marker' => '2026-06-01 00:00:00.000',
                'reference' => $reference,
            ],
        );
    }

    private function moveClockTo(string $iso): void
    {
        $target = new \DateTimeImmutable($iso, new \DateTimeZone('UTC'));
        $this->clock->advanceSeconds($target->getTimestamp() - $this->clock->now()->getTimestamp());
    }

    /** @param array<string, mixed> $parameters */
    private function rowCount(string $sql, array $parameters = []): int
    {
        return (int) ($this->database->fetchOne($sql, $parameters)['n'] ?? 0);
    }
}
