<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Admin\AdminAccountRepository;
use Eszter\Admin\AdminEmail;
use Eszter\Booking\AvailabilityRepository;
use Eszter\Booking\BookableServiceNotFoundException;
use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\BookableServiceRevisionConflictException;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingSerializationLock;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\PdoBookingApi;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Booking\AvailabilityWindow;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Media\UploadedFile;
use Eszter\Notification\NotificationPolicy;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Media\FakeUploadTransport;
use Eszter\Tests\Media\MediaFixtures;
use Eszter\Tests\MovableClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-149 — `booking_services` as the administrable service catalog, against
 * the disposable MySQL.
 *
 * What is proved, each as its own test:
 *
 *  - a service is created from the back-office with no source, enum or
 *    contract edit: the key is derived and de-duplicated server-side, and the
 *    new key flows through public discovery and the availability read;
 *  - name/description/duration edits persist under the row's updatedAt token
 *    and public discovery reflects them; a stale token writes nothing;
 *  - archiving removes a service from public discovery and from bookability
 *    while its historical booking stays readable with its stored key and
 *    times, and restoring brings it back;
 *  - a duration change reshapes future slots only;
 *  - the four pre-existing services keep working through the legacy
 *    provisioning path with empty editorial defaults;
 *  - through the production kernel: the admin routes fail closed
 *    (unauthenticated, CSRF, unknown key, malformed body), a managed image
 *    must be catalogued, and the media delete route refuses an asset any
 *    service row — archived included — still references.
 */
final class ServiceCatalogSqlTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const EMAIL = 'admin@example.test';
    private const PASSWORD = 'correct horse battery staple';

    private static bool $migrated = false;

    private \Eszter\Database\Database $database;
    private MovableClock $clock;
    private BookingDomainContract $contract;
    private BookableServiceRepository $services;
    private AvailabilityRepository $availability;
    private PdoBookingApi $api;
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

        $this->clock = new MovableClock(self::NOW);
        $this->contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
        $time = new BookingTimePolicy($this->contract);
        $this->services = new BookableServiceRepository(
            $this->database,
            $this->clock,
            $this->contract,
            new BookingSerializationLock($this->database),
        );
        $this->availability = new AvailabilityRepository(
            $this->database,
            $this->clock,
            $this->contract,
            $time,
            new BookingSerializationLock($this->database),
        );
        $this->api = PdoBookingApi::createDefault(
            $this->database,
            $this->clock,
            $this->contract,
            NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
        );
        $this->root = TestEnvironment::makeTempDirectory('eszter-catalog');

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

    // --- Proof 1: dynamic creation, no enum -----------------------------------

    public function testAServiceIsCreatedFromTheBackOfficeWithADerivedKeyAndNoContractEdit(): void
    {
        $created = $this->api->adminMutateService([
            'action' => 'create',
            'label' => '  Microblading sourcils  ',
            'description' => 'Une ligne à la fois.',
            'durationMinutes' => 90,
            'imageSrc' => null,
        ]);

        self::assertSame('microblading-sourcils', $created['service']['key']);
        self::assertSame('Microblading sourcils', $created['service']['label']);
        self::assertSame('Une ligne à la fois.', $created['service']['description']);
        self::assertSame(90, $created['service']['durationMinutes']);
        self::assertNull($created['service']['imageSrc']);
        self::assertSame('active', $created['service']['status']);
        self::assertSame(self::NOW, $created['service']['updatedAt']);

        // The same name again: the key is de-duplicated, never overwritten.
        $this->clock->advanceSeconds(1);
        $twin = $this->api->adminMutateService([
            'action' => 'create',
            'label' => 'Microblading sourcils',
            'description' => '',
            'durationMinutes' => 60,
            'imageSrc' => null,
        ]);
        self::assertSame('microblading-sourcils-2', $twin['service']['key']);

        // Accents and punctuation fold to the frozen shape; a name with no
        // usable characters gets the deterministic fallback stem.
        $this->clock->advanceSeconds(1);
        $accented = $this->api->adminMutateService([
            'action' => 'create',
            'label' => 'Éclat & Soin — 2026 !',
            'description' => '',
            'durationMinutes' => 45,
            'imageSrc' => null,
        ]);
        self::assertSame('eclat-soin-2026', $accented['service']['key']);
        $this->clock->advanceSeconds(1);
        $numeric = $this->api->adminMutateService([
            'action' => 'create',
            'label' => '2026',
            'description' => '',
            'durationMinutes' => 45,
            'imageSrc' => null,
        ]);
        self::assertSame('prestation', $numeric['service']['key']);

        // The brand-new key is a first-class service for the public surface:
        // discovery lists it and the availability read accepts it, with no
        // frozen key list consulted anywhere.
        $public = $this->api->services()['services'];
        self::assertSame(
            ['microblading-sourcils', 'microblading-sourcils-2', 'eclat-soin-2026', 'prestation'],
            array_column($public, 'key'),
        );
        self::assertSame(
            ['key', 'label', 'description', 'durationMinutes', 'imageSrc'],
            array_keys($public[0]),
        );
        $availability = $this->api->availability([
            'serviceKey' => 'microblading-sourcils',
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ]);
        self::assertSame('microblading-sourcils', $availability['serviceKey']);
        self::assertSame([], $availability['slots'], 'no schedule yet, but the key resolved');

        // A well-formed key that names no row is still the domain's refusal.
        try {
            $this->api->availability([
                'serviceKey' => 'nails',
                'fromDate' => '2026-06-15',
                'untilDate' => '2026-06-15',
            ]);
            self::fail('an unknown key produced availability');
        } catch (BookingValidationException $exception) {
            self::assertSame('serviceKey', $exception->field);
        }

        // Invalid shapes are refused with zero rows written.
        $before = $this->rowCount();
        foreach (
            [
                ['label' => '', 'description' => '', 'durationMinutes' => 60],
                ['label' => str_repeat('x', 161), 'description' => '', 'durationMinutes' => 60],
                ['label' => 'Ok', 'description' => str_repeat('d', 2001), 'durationMinutes' => 60],
                ['label' => 'Ok', 'description' => '', 'durationMinutes' => 4],
                ['label' => 'Ok', 'description' => '', 'durationMinutes' => 481],
            ] as $invalid
        ) {
            try {
                $this->api->adminMutateService(['action' => 'create', 'imageSrc' => null] + $invalid);
                self::fail('an invalid service was created: ' . json_encode($invalid));
            } catch (BookingValidationException) {
                // expected
            }
        }
        self::assertSame($before, $this->rowCount());
    }

    // --- Proof 2: edits persist, discovery follows, stale tokens write nothing --

    public function testEditsPersistUnderTheTokenAndPublicDiscoveryReflectsThem(): void
    {
        $this->services->provision('brows', 'Sourcils', 120, 15, 15, true);
        $token = $this->adminService('brows')['updatedAt'];
        $this->clock->advanceMinutes(1);

        $updated = $this->api->adminMutateService([
            'action' => 'update',
            'key' => 'brows',
            'expectedUpdatedAt' => $token,
            'label' => 'Sourcils poudrés',
            'description' => 'Un effet maquillé, naturel.',
            'durationMinutes' => 150,
            'imageSrc' => null,
        ]);
        self::assertSame('Sourcils poudrés', $updated['service']['label']);
        self::assertSame(150, $updated['service']['durationMinutes']);
        self::assertNotSame($token, $updated['service']['updatedAt'], 'an edit mints a new token');

        $row = $this->database->fetchOne(
            'SELECT booking_label, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,'
            . ' is_active, image_src FROM booking_services WHERE service_key = :key',
            ['key' => 'brows'],
        );
        self::assertSame('Sourcils poudrés', $row['booking_label'] ?? null);
        self::assertSame('Un effet maquillé, naturel.', $row['description'] ?? null);
        self::assertSame(150, (int) ($row['duration_minutes'] ?? 0));
        self::assertSame(15, (int) ($row['buffer_before_minutes'] ?? 0), 'buffers are not the back-office\'s to edit');
        self::assertSame(1, (int) ($row['is_active'] ?? 0));
        self::assertNull($row['image_src'] ?? null);

        $public = $this->api->services()['services'];
        self::assertSame([[
            'key' => 'brows',
            'label' => 'Sourcils poudrés',
            'description' => 'Un effet maquillé, naturel.',
            'durationMinutes' => 150,
            'imageSrc' => null,
        ]], $public);

        // The stale token — the one the edit just replaced — is refused and
        // the row is byte-untouched.
        try {
            $this->api->adminMutateService([
                'action' => 'update',
                'key' => 'brows',
                'expectedUpdatedAt' => $token,
                'label' => 'Écrasement',
                'description' => '',
                'durationMinutes' => 30,
                'imageSrc' => null,
            ]);
            self::fail('a stale token overwrote the service');
        } catch (BookableServiceRevisionConflictException $conflict) {
            self::assertSame($token, $conflict->expectedUpdatedAt);
            self::assertSame($updated['service']['updatedAt'], $conflict->currentUpdatedAt);
        }
        self::assertSame($updated['service'], $this->adminService('brows'));

        try {
            $this->api->adminMutateService([
                'action' => 'archive',
                'key' => 'lips',
                'expectedUpdatedAt' => $token,
            ]);
            self::fail('an unknown key was archived');
        } catch (BookableServiceNotFoundException $missing) {
            self::assertSame('lips', $missing->serviceKey);
        }
    }

    // --- Proof 3: archive is non-destructive and future-only -------------------

    public function testArchiveRemovesTheServiceFromNewReservationsButKeepsItsBookingsReadable(): void
    {
        $this->services->provision('brows', 'Sourcils', 30, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availability->revision(), [$this->mondayRule()]);
        $booking = $this->api->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        self::assertSame('brows', $booking['serviceKey']);

        $token = $this->adminService('brows')['updatedAt'];
        $archived = $this->api->adminMutateService([
            'action' => 'archive',
            'key' => 'brows',
            'expectedUpdatedAt' => $token,
        ]);
        self::assertSame('archived', $archived['service']['status']);

        // Gone from public discovery and from bookability…
        self::assertSame([], $this->api->services()['services']);
        try {
            $this->api->availability([
                'serviceKey' => 'brows',
                'fromDate' => '2026-06-15',
                'untilDate' => '2026-06-21',
            ]);
            self::fail('an archived service produced availability');
        } catch (BookingValidationException $exception) {
            self::assertStringContainsString('not actively bookable', $exception->getMessage());
        }
        try {
            $this->api->create($this->publicBookingRequest('brows', '2026-06-15T08:00:00.000Z'));
            self::fail('an archived service accepted a booking');
        } catch (BookingValidationException) {
            // expected
        }

        // …but the row, its key and the booking that names it all survive,
        // and the back-office still lists it so the calendar can name it.
        self::assertSame(1, $this->rowCount());
        $admin = $this->api->adminServices()['services'];
        self::assertSame(['brows'], array_column($admin, 'key'));
        self::assertSame('archived', $admin[0]['status']);
        $detail = $this->api->adminQuery(['mode' => 'reference', 'reference' => $booking['reference']]);
        self::assertSame('brows', $detail['booking']['serviceKey']);
        self::assertSame('2026-06-15T07:00:00.000Z', $detail['booking']['startsAtUtc']);
        self::assertSame('2026-06-15T07:30:00.000Z', $detail['booking']['endsAtUtc']);
        self::assertSame('confirmed', $detail['booking']['state']);
        $range = $this->api->adminQuery([
            'mode' => 'range',
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ]);
        self::assertSame([$booking['reference']], array_column($range['bookings'], 'reference'));

        // Restoring is the reverse act under the new token.
        $restored = $this->api->adminMutateService([
            'action' => 'restore',
            'key' => 'brows',
            'expectedUpdatedAt' => $archived['service']['updatedAt'],
        ]);
        self::assertSame('active', $restored['service']['status']);
        self::assertSame(['brows'], array_column($this->api->services()['services'], 'key'));
    }

    public function testADurationChangeReshapesFutureSlotsAndLeavesExistingBookingsAlone(): void
    {
        $this->services->provision('brows', 'Sourcils', 60, 0, 0, true);
        $this->availability->replaceWeeklyRules($this->availability->revision(), [$this->mondayRule()]);
        $booking = $this->api->create($this->publicBookingRequest('brows', '2026-06-15T07:00:00.000Z'));
        self::assertSame('2026-06-15T08:00:00.000Z', $booking['endsAtUtc']);

        $this->api->adminMutateService([
            'action' => 'update',
            'key' => 'brows',
            'expectedUpdatedAt' => $this->adminService('brows')['updatedAt'],
            'label' => 'Sourcils',
            'description' => '',
            'durationMinutes' => 30,
            'imageSrc' => null,
        ]);

        $stored = $this->database->fetchOne(
            'SELECT starts_at_utc, ends_at_utc, service_key FROM bookings WHERE reference = :reference',
            ['reference' => $booking['reference']],
        );
        self::assertSame('2026-06-15 07:00:00.000', $stored['starts_at_utc'] ?? null);
        self::assertSame('2026-06-15 08:00:00.000', $stored['ends_at_utc'] ?? null, 'the booking keeps its stored end');
        self::assertSame('brows', $stored['service_key'] ?? null);

        // New slots are 30 minutes long and the existing booking still
        // occupies its full stored hour.
        $slots = $this->api->availability([
            'serviceKey' => 'brows',
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
        ])['slots'];
        self::assertSame(['10:00', '10:15', '10:30'], array_column($slots, 'localStart'));
        self::assertSame('2026-06-15T08:30:00.000Z', $slots[0]['endsAtUtc']);
    }

    // --- Proof 4: the four existing services stay compatible ------------------

    public function testTheFourExistingServicesStayCompatibleThroughLegacyProvisioning(): void
    {
        foreach (['brows', 'eyeliner', 'lips', 'freckles'] as $key) {
            $this->clock->advanceSeconds(1);
            $result = $this->services->provision($key, ucfirst($key), 60, 15, 15, true);
            self::assertTrue($result['created']);
            self::assertSame('', $result['service']->description, 'nothing is fabricated for an old row');
            self::assertNull($result['service']->imageSrc);
        }

        self::assertSame(
            ['brows', 'eyeliner', 'lips', 'freckles'],
            array_column($this->api->adminServices()['services'], 'key'),
            'catalog order is creation order',
        );
        self::assertCount(4, $this->api->services()['services']);

        // Re-provisioning refreshes the operational facts and, with null
        // editorial arguments, leaves the admin-owned facts as stored.
        $this->api->adminMutateService([
            'action' => 'update',
            'key' => 'lips',
            'expectedUpdatedAt' => $this->adminService('lips')['updatedAt'],
            'label' => 'Lèvres',
            'description' => 'Contour et remplissage.',
            'durationMinutes' => 90,
            'imageSrc' => null,
        ]);
        $again = $this->services->provision('lips', 'Lèvres', 120, 10, 10, true);
        self::assertFalse($again['created']);
        self::assertSame('Contour et remplissage.', $again['service']->description);
        self::assertSame(120, $again['service']->durationMinutes);
        self::assertSame(10, $again['service']->bufferBeforeMinutes);

        $this->availability->replaceWeeklyRules($this->availability->revision(), [$this->mondayRule()]);
        // 09:15 local: the 15-minute buffer before it still fits the 09:00 window.
        $booking = $this->api->create($this->publicBookingRequest('freckles', '2026-06-15T07:15:00.000Z'));
        self::assertSame('freckles', $booking['serviceKey']);
    }

    // --- Proof 5: the production kernel — fail-closed routes and media --------

    public function testTheAdminRoutesFailClosedAndAReferencedImageCannotBeDeleted(): void
    {
        // The kernel opens its own connection: leave the rollback-only wrapper.
        $this->database->rollBack();
        TestDatabase::truncateData($this->database);
        (new AdminAccountRepository($this->database, $this->clock))
            ->provision(AdminEmail::fromString(self::EMAIL, TestEnvironment::artifacts()), self::PASSWORD, true);
        $this->services->provision('brows', 'Sourcils', 30, 0, 0, true);

        $settings = TestDatabase::settings();
        $configPath = TestEnvironment::writeDeployment($this->root, [
            'database' => [
                'dsn' => $settings->dsn,
                'username' => $settings->username,
                'password' => $settings->password,
                'connectTimeoutSeconds' => $settings->connectTimeoutSeconds,
            ],
        ]);
        TestEnvironment::writeExportedPage($this->root);
        $transport = new FakeUploadTransport();
        $kernel = Kernel::boot($configPath, new FrozenClock(self::NOW), null, null, null, null, $transport);

        // Anonymous: refused before any body is read.
        self::assertSame(401, $kernel->handle(new Request('GET', '/api/admin/services'))->status);
        self::assertSame(401, $kernel->handle(new Request('PATCH', '/api/admin/services', [], '{invalid'))->status);

        [$cookie, $csrf] = $this->signIn($kernel);
        $auth = ['cookie' => $cookie, 'content-type' => 'application/json'];
        $mutation = $auth + [$this->csrfHeader() => $csrf];

        // Authenticated read lists the seeded row with its admin shape.
        $list = $kernel->handle(new Request('GET', '/api/admin/services', ['cookie' => $cookie]));
        self::assertSame(200, $list->status, (string) $list->body);
        self::assertSame('no-store', $list->header('Cache-Control'));
        $listed = $list->decodedBody()['services'] ?? null;
        self::assertIsArray($listed);
        self::assertSame(['brows'], array_column($listed, 'key'));
        $token = (string) $listed[0]['updatedAt'];

        // CSRF omitted on a mutation: 403, and the row is untouched.
        $noCsrf = $kernel->handle(new Request('PATCH', '/api/admin/services', $auth, (string) json_encode([
            'action' => 'archive',
            'key' => 'brows',
            'expectedUpdatedAt' => $token,
        ])));
        self::assertSame(403, $noCsrf->status);
        self::assertSame('CSRF_TOKEN_INVALID', $this->errorCode($noCsrf));
        self::assertSame(1, (int) ($this->serviceRow('brows')['is_active'] ?? 0));

        // Malformed bodies: a delete action, an external image URL, an
        // out-of-bounds duration — all schema refusals, nothing written.
        foreach (
            [
                ['action' => 'delete', 'key' => 'brows', 'expectedUpdatedAt' => $token],
                ['action' => 'create', 'label' => 'X', 'description' => '', 'durationMinutes' => 60,
                    'imageSrc' => 'https://example.test/photo.jpg'],
                ['action' => 'create', 'label' => 'X', 'description' => '', 'durationMinutes' => 1000,
                    'imageSrc' => null],
                ['action' => 'create', 'label' => 'X', 'description' => '', 'durationMinutes' => 60,
                    'imageSrc' => '/etc/passwd'],
            ] as $body
        ) {
            $refused = $kernel->handle(
                new Request('PATCH', '/api/admin/services', $mutation, (string) json_encode($body)),
            );
            self::assertSame(400, $refused->status, (string) $refused->body);
            self::assertSame('VALIDATION_FAILED', $this->errorCode($refused));
        }
        self::assertSame(1, $this->rowCount());

        // A well-formed managed path the catalogue does not carry is refused
        // by the domain, not stored as a broken image.
        $dangling = $kernel->handle(new Request('PATCH', '/api/admin/services', $mutation, (string) json_encode([
            'action' => 'create',
            'label' => 'Image fantôme',
            'description' => '',
            'durationMinutes' => 60,
            'imageSrc' => '/media/med_' . str_repeat('a', 32) . '.jpg',
        ])));
        self::assertSame(400, $dangling->status, (string) $dangling->body);
        self::assertSame(1, $this->rowCount());

        // Unknown key and stale token map to the frozen 404 / 409.
        $unknown = $kernel->handle(new Request('PATCH', '/api/admin/services', $mutation, (string) json_encode([
            'action' => 'archive',
            'key' => 'nails',
            'expectedUpdatedAt' => $token,
        ])));
        self::assertSame(404, $unknown->status);
        self::assertSame('NOT_FOUND', $this->errorCode($unknown));
        $stale = $kernel->handle(new Request('PATCH', '/api/admin/services', $mutation, (string) json_encode([
            'action' => 'archive',
            'key' => 'brows',
            'expectedUpdatedAt' => '2020-01-01T00:00:00.000Z',
        ])));
        self::assertSame(409, $stale->status);
        self::assertSame('REVISION_CONFLICT', $this->errorCode($stale));
        self::assertSame(1, (int) ($this->serviceRow('brows')['is_active'] ?? 0));

        // Now the media half: upload a real asset through the media route…
        $staged = $transport->stage($this->root, MediaFixtures::jpeg());
        $upload = $kernel->handle(new Request(
            'POST',
            '/api/admin/media',
            ['cookie' => $cookie, $this->csrfHeader() => $csrf, 'content-type' => 'multipart/form-data; boundary=x'],
            '',
            [new UploadedFile('file', $staged, \strlen(MediaFixtures::jpeg()), \UPLOAD_ERR_OK, 'p.jpg', 'image/jpeg')],
        ));
        self::assertSame(201, $upload->status, (string) $upload->body);
        $asset = $upload->decodedBody()['asset'] ?? null;
        self::assertIsArray($asset);
        $assetId = (string) $asset['id'];
        $assetPath = (string) $asset['path'];

        // …attach it to a new service, and check the same stored path feeds
        // the admin list and the public reservation catalog — one asset, no
        // duplicate bytes.
        $created = $kernel->handle(new Request('PATCH', '/api/admin/services', $mutation, (string) json_encode([
            'action' => 'create',
            'label' => 'Taches de rousseur',
            'description' => 'Un semis naturel.',
            'durationMinutes' => 60,
            'imageSrc' => $assetPath,
        ])));
        self::assertSame(200, $created->status, (string) $created->body);
        $service = $created->decodedBody()['service'] ?? null;
        self::assertIsArray($service);
        self::assertSame('taches-de-rousseur', $service['key']);
        self::assertSame($assetPath, $service['imageSrc']);
        $public = $kernel->handle(new Request('GET', '/api/booking/services'));
        self::assertSame(200, $public->status);
        $publicServices = $public->decodedBody()['services'] ?? [];
        self::assertIsArray($publicServices);
        self::assertSame([null, $assetPath], array_column($publicServices, 'imageSrc'));
        self::assertSame(['brows', 'taches-de-rousseur'], array_column($publicServices, 'key'));
        self::assertSame(
            [],
            $kernel->mediaLibrary->missingCataloguedPaths([$assetPath]),
            'the service points at the catalogued asset, not a copy',
        );

        // The delete route refuses while a service references the asset…
        $delete = fn (): Response => $kernel->handle(new Request(
            'DELETE',
            '/api/admin/media',
            $mutation,
            (string) json_encode(['id' => $assetId]),
        ));
        $refused = $delete();
        self::assertSame(409, $refused->status, (string) $refused->body);
        self::assertSame('MEDIA_REFERENCED', $this->errorCode($refused));
        self::assertFileExists($this->root . '/public_html/media/' . basename($assetPath));

        // …and still refuses when that service is archived: restoring it must
        // not reveal a broken image.
        $archived = $kernel->handle(new Request('PATCH', '/api/admin/services', $mutation, (string) json_encode([
            'action' => 'archive',
            'key' => 'taches-de-rousseur',
            'expectedUpdatedAt' => $service['updatedAt'],
        ])));
        self::assertSame(200, $archived->status, (string) $archived->body);
        self::assertSame(409, $delete()->status);

        // Detaching the image is what frees the asset.
        $detached = $kernel->handle(new Request('PATCH', '/api/admin/services', $mutation, (string) json_encode([
            'action' => 'update',
            'key' => 'taches-de-rousseur',
            'expectedUpdatedAt' => (string) ($archived->decodedBody()['service']['updatedAt'] ?? ''),
            'label' => 'Taches de rousseur',
            'description' => 'Un semis naturel.',
            'durationMinutes' => 60,
            'imageSrc' => null,
        ])));
        self::assertSame(200, $detached->status, (string) $detached->body);
        $detachedRow = $this->serviceRow('taches-de-rousseur');
        self::assertIsArray($detachedRow);
        self::assertArrayHasKey('image_src', $detachedRow);
        self::assertNull($detachedRow['image_src']);
        self::assertSame(204, $delete()->status);
        self::assertFileDoesNotExist($this->root . '/public_html/media/' . basename($assetPath));
    }

    // --- helpers ---------------------------------------------------------------

    /** @return array<string, mixed> */
    private function adminService(string $key): array
    {
        foreach ($this->api->adminServices()['services'] as $service) {
            if ($service['key'] === $key) {
                /** @var array<string, mixed> $service */
                return $service;
            }
        }
        self::fail("no admin service {$key}");
    }

    /** @return array<string, mixed>|null */
    private function serviceRow(string $key): ?array
    {
        return $this->database->fetchOne(
            'SELECT service_key, booking_label, description, image_src, is_active, updated_at'
            . ' FROM booking_services WHERE service_key = :key',
            ['key' => $key],
        );
    }

    private function rowCount(): int
    {
        return (int) ($this->database->fetchOne('SELECT COUNT(*) AS n FROM booking_services')['n'] ?? -1);
    }

    private function mondayRule(): WeeklyAvailabilityRule
    {
        return new WeeklyAvailabilityRule(
            0,
            1,
            AvailabilityWindow::create('09:00', '11:00', null, $this->contract),
            null,
            null,
            true,
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
            'consentNoticeId' => $this->contract->currentConsentNoticeId,
            'consentAccepted' => true,
        ];
    }

    /** @return array{string, string} The session cookie header value and the CSRF token. */
    private function signIn(Kernel $kernel): array
    {
        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        self::assertSame(200, $anonymous->status);
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $login = $kernel->handle(new Request(
            'POST',
            '/api/auth/login',
            [
                'cookie' => $this->cookieName() . '=' . $this->cookieValue($anonymous),
                $this->csrfHeader() => (string) $anonymousBody['csrfToken'],
                'content-type' => 'application/json',
            ],
            (string) json_encode(['email' => self::EMAIL, 'password' => self::PASSWORD]),
        ));
        self::assertSame(200, $login->status, (string) $login->body);
        /** @var array<string, mixed> $loginBody */
        $loginBody = $login->decodedBody();

        return [
            $this->cookieName() . '=' . $this->cookieValue($login),
            (string) $loginBody['csrfToken'],
        ];
    }

    private function cookieValue(Response $response): string
    {
        $cookie = (string) $response->header('Set-Cookie');

        return preg_match('/=([0-9a-f]{64});/', $cookie, $match) === 1 ? $match[1] : '';
    }

    private function cookieName(): string
    {
        /** @var array<string, mixed> $cookie */
        $cookie = TestEnvironment::artifacts()->authContract()['sessionCookie'];

        return (string) $cookie['name'];
    }

    private function csrfHeader(): string
    {
        /** @var array<string, mixed> $csrf */
        $csrf = TestEnvironment::artifacts()->authContract()['csrf'];

        return (string) $csrf['header'];
    }

    private function errorCode(Response $response): ?string
    {
        $body = $response->decodedBody();

        return \is_array($body) && \is_array($body['error'] ?? null) && \is_string($body['error']['code'] ?? null)
            ? $body['error']['code']
            : null;
    }
}
