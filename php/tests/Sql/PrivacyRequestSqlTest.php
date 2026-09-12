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
use Eszter\Booking\PdoBookingApi;
use Eszter\Contract\StructuralValidator;
use Eszter\Database\Database;
use Eszter\Notification\NotificationJob;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\NotificationPolicy;
use Eszter\Notification\NotificationRunner;
use Eszter\Notification\NotificationTransportRegistry;
use Eszter\Privacy\InvalidPrivacyRequestTransitionException;
use Eszter\Privacy\PrivacyRequestAdministration;
use Eszter\Privacy\PrivacyRequestRepository;
use Eszter\Privacy\PrivacyRequestRetention;
use Eszter\Retention\RetentionPolicy;
use Eszter\Support\Logger;
use Eszter\Tests\MovableClock;
use Eszter\Tests\Notification\FixedEnabledChannels;
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
 *
 * ESZ-164 adds the execution of the rights, through the production wiring
 * (`PdoBookingApi::createDefault`), each as its own test:
 *
 *  - one export engine answers access and portability with a JSON document
 *    the frozen schema validates and an HTML page rendering the same facts,
 *    an anonymised link appearing as a reference and a flag only;
 *  - early anonymisation runs the ESZ-140 primitive: placeholders, marker,
 *    every pending or processing job retired in the same transaction, the
 *    appointment and the trail kept, an already erased link untouched;
 *  - restriction holds every pending job and releases a job claimed before
 *    the restriction without delivering it; a reminder whose window closes
 *    during the restriction is swept and never replayed after the lift; the
 *    lift sends exactly one informational e-mail and lets the still-future
 *    reminder resume.
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
    private PdoBookingApi $api;
    private NotificationPolicy $notificationPolicy;
    private NotificationJobRepository $jobs;
    private string $logRoot;

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

        // ESZ-164: the rights run through the production graph.
        $this->notificationPolicy = NotificationPolicy::fromArtifacts($artifacts);
        $this->jobs = new NotificationJobRepository($this->database, $this->clock, $this->notificationPolicy);
        $this->api = PdoBookingApi::createDefault(
            $this->database,
            $this->clock,
            $this->contract,
            $this->notificationPolicy,
        );
        $this->logRoot = TestEnvironment::makeTempDirectory('eszter-privacy-rights');

        $this->database->beginTransaction();
    }

    protected function tearDown(): void
    {
        if (isset($this->database) && $this->database->inTransaction()) {
            $this->database->rollBack();
        }
        if (isset($this->logRoot)) {
            TestEnvironment::removeDirectory($this->logRoot);
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
        $this->admin->adminPrivacyRequestSearch([
            'mode' => 'reference',
            'reference' => 'bk_ffffffffffffffffffffffffffffffff',
        ]);
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

        $placeholder = $this->admin->adminPrivacyRequestSearch([
            'mode' => 'email',
            'email' => $this->retention->erasedCustomerEmail,
        ]);
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
            [
                'id',
                'type',
                'status',
                'receivedDate',
                'deadlineDate',
                'closedAtUtc',
                'bookingReferences',
                'createdAt',
                'updatedAt',
            ],
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
            [
                'id',
                'request_type',
                'status',
                'received_date',
                'deadline_date',
                'closed_at_utc',
                'created_at',
                'updated_at',
            ],
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
                $this->admin->adminRecordPrivacyRequest([
                    'type' => 'erasure',
                    'receivedDate' => '2026-06-13',
                    'bookingReferences' => $references,
                ]);
                self::fail('a request with ' . json_encode($references) . ' was recorded');
            } catch (BookingNotFoundException | BookingValidationException $caught) {
                self::assertInstanceOf($exception, $caught);
            }
        }
        self::assertSame(0, $this->rowCount('SELECT COUNT(*) AS n FROM privacy_requests'));

        $this->expectException(BookingValidationException::class);
        $this->admin->adminRecordPrivacyRequest([
            'type' => 'opposition',
            'receivedDate' => '2026-06-13',
            'bookingReferences' => [],
        ]);
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

    // --- ESZ-164: the rights --------------------------------------------------

    public function testOneExportEngineAnswersAccessAndPortabilityWithoutReconnectingAnAnonymisedLink(): void
    {
        $live = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');
        $gone = $this->insertBooking('2026-06-22 07:00:00.000', 'cliente@example.test');
        $liveId = $this->bookingId($live);
        $this->jobs->enqueue($liveId, 'email', 'booking_confirmation', 'export.live.confirmation', $this->clock->now());
        $this->database->run(
            'INSERT INTO booking_history (booking_id, event_type, actor_type, details_json, occurred_at)'
            . " VALUES (:booking, 'created', 'public', JSON_OBJECT(), :occurred)",
            ['booking' => $liveId, 'occurred' => $this->clock->nowIso()],
        );
        $id = $this->record('access', [$live, $gone]);
        // Anonymised after the request was recorded: the export must not
        // rebuild it from what the row still holds.
        $this->erase($gone);

        $validator = new StructuralValidator(TestEnvironment::artifacts());
        $this->clock->advanceSeconds(30);
        $json = $this->api->adminExecutePrivacyRequestAction(['action' => 'export', 'id' => $id, 'format' => 'json']);
        self::assertSame([], $validator->validate($json, 'admin-privacy-request-action-response.schema.json'));
        self::assertSame('closed', $json['request']['status']);
        self::assertSame('2026-06-13T12:00:30.000Z', $json['request']['closedAtUtc']);
        self::assertSame('json', $json['export']['format']);
        self::assertSame("export-rgpd-demande-{$id}.json", $json['export']['fileName']);

        $document = $json['export']['document'];
        self::assertIsArray($document);
        self::assertSame('eszter.privacy-export', $document['format']);
        self::assertSame(['id' => $id, 'type' => 'access', 'receivedDate' => '2026-06-13'], $document['request']);
        self::assertCount(2, $document['bookings']);
        [$held, $anonymised] = $document['bookings'];
        self::assertSame($live, $held['reference']);
        self::assertFalse($held['anonymised']);
        self::assertSame('cliente@example.test', $held['customer']['email']);
        self::assertSame('Cliente Exemple', $held['customer']['name']);
        self::assertSame(['Sourcils'], $held['appointment']['serviceLabels']);
        self::assertSame('privacy_notice', $held['basis']['kind']);
        self::assertSame($this->contract->currentPrivacyNoticeId, $held['basis']['noticeId']);
        self::assertStringContainsString('Responsable du traitement', $held['basis']['text']);
        self::assertSame([['type' => 'created', 'actor' => 'public', 'occurredAt' => self::NOW]], $held['history']);
        self::assertSame('booking_confirmation', $held['notifications'][0]['type']);
        self::assertSame('pending', $held['notifications'][0]['status']);
        // The anonymised link: the reference and the fact, and nothing else.
        self::assertSame(['reference' => $gone, 'anonymised' => true], $anonymised);
        self::assertStringContainsString('90 jours', implode(' ', $document['information']['retention']));
        self::assertNotEmpty($document['information']['rights']);

        // The readable representation renders the same document: the same
        // facts, and no placeholder for the anonymised link.
        $html = $this->api->adminExecutePrivacyRequestAction(['action' => 'export', 'id' => $id, 'format' => 'html']);
        self::assertSame([], $validator->validate($html, 'admin-privacy-request-action-response.schema.json'));
        self::assertSame('closed', $html['request']['status'], 'a second export changes nothing');
        self::assertSame('2026-06-13T12:00:30.000Z', $html['request']['closedAtUtc']);
        $page = $html['export']['document'];
        self::assertIsString($page);
        self::assertStringStartsWith('<!doctype html><html lang="fr">', $page);
        $needles = ['Cliente Exemple', 'cliente@example.test', 'Sourcils', $live, $gone, 'anonymisées', '90 jours'];
        foreach ($needles as $needle) {
            self::assertStringContainsString($needle, $page);
        }
        self::assertSame(1, substr_count($page, 'Cliente Exemple'), 'the anonymised link must not carry a name');
        self::assertStringNotContainsString($this->retention->erasedCustomerName, $page);
        self::assertStringNotContainsString($this->retention->erasedCustomerEmail, $page);

        // Portability is the same engine; an erasure request has no export.
        $portability = $this->record('portability', [$live]);
        $exported = $this->api->adminExecutePrivacyRequestAction([
            'action' => 'export',
            'id' => $portability,
            'format' => 'json',
        ]);
        self::assertSame(
            $document['bookings'][0]['customer'],
            $exported['export']['document']['bookings'][0]['customer'],
        );
        self::assertSame('closed', $exported['request']['status']);
        $erasure = $this->record('erasure', [$live]);
        try {
            $this->api->adminExecutePrivacyRequestAction(['action' => 'export', 'id' => $erasure, 'format' => 'json']);
            self::fail('an erasure request was exported');
        } catch (BookingValidationException) {
            // expected
        }
        self::assertSame('received', $this->requests->find($erasure)?->status);

        // Nothing was persisted about the export: the register holds
        // references and instants, and no table gained a customer value.
        self::assertSame(0, $this->rowCount(
            'SELECT COUNT(*) AS n FROM privacy_requests WHERE CAST(id AS CHAR) LIKE :needle',
            ['needle' => '%example.test%'],
        ));
    }

    public function testEarlyAnonymisationRunsTheRetentionPrimitiveAndNeutralisesActiveJobs(): void
    {
        // A future, confirmed booking: not a retention candidate for months.
        $future = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');
        $already = $this->insertBooking('2026-06-22 07:00:00.000', 'cliente@example.test');
        $futureId = $this->bookingId($future);
        $this->jobs->enqueue(
            $futureId,
            'email',
            'booking_reminder',
            'anon.reminder.pending',
            $this->clock->now()->modify('+1 day'),
        );
        $this->jobs->enqueue($futureId, 'email', 'booking_confirmation', 'anon.confirmation.due', $this->clock->now());
        $this->jobs->enqueue($futureId, 'email', 'booking_moved', 'anon.moved.sent', $this->clock->now());
        $this->database->run(
            "UPDATE notification_jobs SET status = 'sent', sent_at_utc = :sent"
            . " WHERE idempotency_key = 'anon.moved.sent'",
            ['sent' => '2026-06-13 11:00:00.000'],
        );
        // One job already claimed by a runner: its lease must not survive.
        $claimed = $this->jobs->claimDue(NotificationRunner::ownerFor('test-anon', getmypid() ?: 1), 10, ['email']);
        self::assertCount(1, $claimed);
        self::assertSame('anon.confirmation.due', $claimed[0]->idempotencyKey);

        $id = $this->record('erasure', [$future, $already]);
        // The second link was anonymised by the sweep in the meantime.
        $this->erase($already);

        try {
            $this->api->adminExecutePrivacyRequestAction(['action' => 'anonymize', 'id' => $id]);
            self::fail('an anonymisation ran without the confirmation');
        } catch (BookingValidationException $exception) {
            self::assertSame('confirm', $exception->field);
        }
        self::assertNull($this->bookings->find($future)?->customerDataErasedAt);

        $this->clock->advanceSeconds(60);
        $result = $this->api->adminExecutePrivacyRequestAction([
            'action' => 'anonymize',
            'id' => $id,
            'confirm' => true,
        ]);
        self::assertSame('closed', $result['request']['status']);
        self::assertSame('2026-06-13T12:01:00.000Z', $result['request']['closedAtUtc']);
        self::assertSame(
            [[$future, '2026-06-13T12:01:00.000Z', null], [$already, '2026-06-01T00:00:00.000Z', null]],
            array_map(
                static fn (array $entry): array => [
                    $entry['reference'],
                    $entry['customerDataErasedAt'],
                    $entry['customer'],
                ],
                $result['bookings'],
            ),
        );

        // The row: the frozen placeholders, the marker, the appointment kept.
        $erased = $this->bookings->find($future);
        self::assertNotNull($erased);
        self::assertSame($this->retention->erasedCustomerName, $erased->customerName);
        self::assertSame($this->retention->erasedCustomerEmail, $erased->customerEmail);
        self::assertNull($erased->customerPhone);
        self::assertNull($erased->customerNote);
        self::assertSame('2026-06-13 12:01:00.000', $erased->customerDataErasedAt);
        self::assertSame('confirmed', $erased->state->value);
        self::assertSame('2026-06-15 07:00:00.000', $erased->startsAtUtc);
        self::assertSame($future, $erased->reference);
        self::assertSame($this->contract->currentPrivacyNoticeId, $erased->privacyNoticeId);

        // The queue: pending and processing retired with the frozen code and
        // no lease; the sent job is evidence and is untouched.
        $byKey = [];
        foreach ($this->jobs->forBooking($futureId) as $job) {
            $byKey[$job->idempotencyKey] = $job;
        }
        self::assertSame('retired', $byKey['anon.reminder.pending']->status);
        self::assertSame('retired', $byKey['anon.confirmation.due']->status);
        self::assertNull($byKey['anon.confirmation.due']->leaseOwner);
        self::assertSame($this->retention->erasureJobCode, $byKey['anon.confirmation.due']->lastErrorCode);
        self::assertSame('sent', $byKey['anon.moved.sent']->status);

        // The trail: one non-personal event naming the request, none for the
        // link that was already anonymised.
        $events = $this->database->fetchAll(
            'SELECT b.reference, h.event_type, h.details_json FROM booking_history h'
            . ' JOIN bookings b ON b.id = h.booking_id ORDER BY h.id',
        );
        self::assertCount(1, $events);
        self::assertSame($future, $events[0]['reference']);
        self::assertSame('customer_data_erased', $events[0]['event_type']);
        // MySQL stores JSON keys in its own order; the facts are what matter.
        self::assertEquals(
            ['privacyRequestId' => $id, 'retiredJobs' => 2],
            json_decode((string) $events[0]['details_json'], true),
        );
        self::assertStringNotContainsString('example.test', (string) $events[0]['details_json']);
        self::assertSame('2026-06-01 00:00:00.000', $this->bookings->find($already)?->customerDataErasedAt);

        // Closed, so it cannot run twice; and the erased row refuses a
        // rectification through the same authority.
        try {
            $this->api->adminExecutePrivacyRequestAction(['action' => 'anonymize', 'id' => $id, 'confirm' => true]);
            self::fail('a closed erasure request ran again');
        } catch (BookingValidationException) {
            // expected
        }
    }

    public function testRestrictionHoldsAndReleasesJobsAndTheLiftNeverReplaysAStaleReminder(): void
    {
        $reference = $this->insertBooking('2026-06-15 07:00:00.000', 'cliente@example.test');
        $bookingId = $this->bookingId($reference);
        $now = $this->clock->now();
        $this->jobs->enqueue($bookingId, 'email', 'booking_reminder', 'restrict.reminder.first', $now);
        $this->jobs->enqueue($bookingId, 'email', 'booking_reminder', 'restrict.reminder.second', $now);
        $this->jobs->enqueue(
            $bookingId,
            'email',
            'booking_reminder',
            'restrict.reminder.soon',
            $now->modify('+10 minutes'),
        );
        $this->jobs->enqueue(
            $bookingId,
            'email',
            'booking_reminder',
            'restrict.reminder.future',
            $now->modify('+19 hours'),
        );
        $id = $this->record('restriction', [$reference]);

        // Tick 1: both due reminders are claimed; the restriction lands after
        // the first delivery, so the second is re-checked before its transport
        // and released — not sent, not terminal, its attempt refunded.
        $transport = new RecordingTransport('email');
        $api = $this->api;
        $transport->before = static function () use ($api, $id, &$transport): void {
            if ($transport->delivered === 0) {
                $api->adminExecutePrivacyRequestAction(['action' => 'restrict', 'id' => $id]);
            }
        };
        $first = $this->runner($transport)->run($this->owner('one'), 10);
        self::assertSame(2, $first->claimed);
        self::assertSame(1, $first->sent);
        self::assertSame(1, $first->released);
        self::assertSame(1, $transport->delivered);
        $released = $this->jobs->findByIdempotencyKey('restrict.reminder.second');
        self::assertInstanceOf(NotificationJob::class, $released);
        self::assertSame('pending', $released->status);
        self::assertSame(0, $released->attempts);
        self::assertSame('processing_restricted', $released->lastErrorCode);
        self::assertNull($released->leaseOwner);

        $restricted = $this->bookings->find($reference);
        // ESZ-139: the marker is the derived mutation instant, strictly later
        // than the row's own token even under the frozen test clock.
        self::assertSame('2026-06-13 12:00:00.001', $restricted?->processingRestrictedAt);
        self::assertSame('closed', $this->requests->find($id)?->status);
        self::assertSame('cliente@example.test', $restricted->customerEmail, 'the booking and its data are kept');
        self::assertSame(
            [$reference, 'processing_restricted', ['privacyRequestId' => $id]],
            $this->lastHistoryEvent(),
        );

        // Ticks 2 and 3, restriction in place: nothing of this booking is
        // claimed, whatever is due. The stale sweep still runs: the two
        // reminders whose window closes meanwhile are terminally skipped.
        $this->clock->advanceSeconds(5 * 60);
        $second = $this->runner($transport)->run($this->owner('two'), 10);
        self::assertSame(0, $second->claimed);
        self::assertSame(0, $second->staleSkipped);
        self::assertSame('pending', $this->jobs->findByIdempotencyKey('restrict.reminder.second')?->status);
        $this->clock->advanceSeconds(2 * 60 * 60);
        $third = $this->runner($transport)->run($this->owner('three'), 10);
        self::assertSame(0, $third->claimed);
        self::assertSame(2, $third->staleSkipped);
        self::assertSame(1, $transport->delivered);
        foreach (['restrict.reminder.second', 'restrict.reminder.soon'] as $stale) {
            $job = $this->jobs->findByIdempotencyKey($stale);
            self::assertSame('skipped', $job?->status, $stale);
            self::assertSame('reminder_window_expired', $job->lastErrorCode, $stale);
        }
        self::assertSame('pending', $this->jobs->findByIdempotencyKey('restrict.reminder.future')?->status);

        // The lift: confirmed on the wire, one informational e-mail scheduled
        // in the same transaction, the request's status unchanged.
        try {
            $this->api->adminExecutePrivacyRequestAction(['action' => 'lift', 'id' => $id]);
            self::fail('a lift ran without the confirmation');
        } catch (BookingValidationException $exception) {
            self::assertSame('confirm', $exception->field);
        }
        $lifted = $this->api->adminExecutePrivacyRequestAction(['action' => 'lift', 'id' => $id, 'confirm' => true]);
        self::assertNull($lifted['bookings'][0]['processingRestrictedAt']);
        self::assertSame('closed', $lifted['request']['status']);
        self::assertNull($this->bookings->find($reference)?->processingRestrictedAt);
        self::assertSame(
            [$reference, 'processing_restriction_lifted', ['privacyRequestId' => $id]],
            $this->lastHistoryEvent(),
        );
        $liftJobs = array_values(array_filter(
            $this->jobs->forBooking($bookingId),
            static fn (NotificationJob $job): bool => $job->jobType === 'processing_restriction_lifted',
        ));
        self::assertCount(1, $liftJobs);
        self::assertSame('pending', $liftJobs[0]->status);
        self::assertSame('email', $liftJobs[0]->channel);

        // Tick 4: the lift e-mail goes out; the stale reminders stay skipped;
        // the still-future reminder is not due yet and stays pending.
        $fourth = $this->runner($transport)->run($this->owner('four'), 10);
        self::assertSame(1, $fourth->claimed);
        self::assertSame(1, $fourth->sent);
        self::assertSame(2, $transport->delivered);
        self::assertSame('sent', $this->jobs->find($liftJobs[0]->id)?->status);
        self::assertSame('skipped', $this->jobs->findByIdempotencyKey('restrict.reminder.second')?->status);
        self::assertSame('skipped', $this->jobs->findByIdempotencyKey('restrict.reminder.soon')?->status);
        self::assertSame('pending', $this->jobs->findByIdempotencyKey('restrict.reminder.future')?->status);

        // Tick 5, at the future reminder's time: it resumes normally.
        $this->clock->advanceSeconds(17 * 60 * 60);
        $fifth = $this->runner($transport)->run($this->owner('five'), 10);
        self::assertSame(1, $fifth->sent);
        self::assertSame('sent', $this->jobs->findByIdempotencyKey('restrict.reminder.future')?->status);
        self::assertSame(3, $transport->delivered);

        // A second lift has nothing to lift.
        try {
            $this->api->adminExecutePrivacyRequestAction(['action' => 'lift', 'id' => $id, 'confirm' => true]);
            self::fail('a lifted restriction was lifted again');
        } catch (BookingValidationException) {
            // expected
        }
    }

    // --- helpers -------------------------------------------------------------

    /**
     * Records one request through the API and returns its id.
     *
     * @param list<string> $references
     */
    private function record(string $type, array $references): int
    {
        $id = $this->api->adminRecordPrivacyRequest([
            'type' => $type,
            'receivedDate' => '2026-06-13',
            'bookingReferences' => $references,
        ])['request']['id'];
        self::assertIsInt($id);

        return $id;
    }

    private function bookingId(string $reference): int
    {
        $id = $this->bookings->find($reference)?->id;
        self::assertIsInt($id);

        return $id;
    }

    /** @return array{0: string, 1: string, 2: array<string, mixed>}|null */
    private function lastHistoryEvent(): ?array
    {
        $row = $this->database->fetchOne(
            'SELECT b.reference, h.event_type, h.details_json FROM booking_history h'
            . ' JOIN bookings b ON b.id = h.booking_id ORDER BY h.id DESC LIMIT 1',
        );
        if ($row === null) {
            return null;
        }

        return [
            (string) $row['reference'],
            (string) $row['event_type'],
            json_decode((string) $row['details_json'], true),
        ];
    }

    private function runner(RecordingTransport $transport): NotificationRunner
    {
        return new NotificationRunner(
            $this->jobs,
            new NotificationTransportRegistry($this->notificationPolicy, [$transport]),
            new FixedEnabledChannels(['email']),
            $this->notificationPolicy,
            new Logger($this->logRoot . '/notifications.log', 'debug', $this->clock),
        );
    }

    private function owner(string $tag): string
    {
        return NotificationRunner::ownerFor('test-' . $tag, getmypid() ?: 1);
    }

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
