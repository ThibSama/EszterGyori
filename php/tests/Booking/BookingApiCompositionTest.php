<?php

declare(strict_types=1);

namespace Eszter\Tests\Booking;

use Eszter\Booking\AvailabilityAdministration;
use Eszter\Booking\BookingAdminReader;
use Eszter\Booking\BookingApi;
use Eszter\Booking\BookingLifecycle;
use Eszter\Booking\BookingPayloads;
use Eszter\Booking\BookingRequestFields;
use Eszter\Booking\BookingServiceCatalog;
use Eszter\Booking\PdoBookingApi;
use Eszter\Booking\SlotAvailability;
use Eszter\Config\DatabaseSettings;
use Eszter\Database\Database;
use Eszter\Notification\NotificationPolicy;
use Eszter\Booking\BookingDomainContract;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-106 architecture proofs: `PdoBookingApi` is a thin compatibility
 * façade over one collaborator per use-case family, every `BookingApi` method
 * is still wired, and each preserved rule has exactly one owner. No database
 * is needed: `Database` opens no connection until the first query, so the
 * whole `createDefault()` graph is constructible against an unreachable DSN.
 */
final class BookingApiCompositionTest extends TestCase
{
    /** The frozen 10-method booking surface (ESZ-105/ESZ-106). */
    private const API_METHODS = [
        'services',
        'availability',
        'create',
        'adminQuery',
        'adminMoveAvailability',
        'adminMutate',
        'adminSummary',
        'adminAvailability',
        'adminReplaceWeeklyAvailability',
        'adminMutateAvailabilityException',
    ];

    /**
     * Each `BookingApi` method delegates to exactly one collaborator method of
     * the same name: use case name -> [collaborator class, façade property].
     *
     * @var array<string, array{class-string, string}>
     */
    private const DELEGATIONS = [
        'services' => [BookingServiceCatalog::class, 'serviceCatalog'],
        'availability' => [SlotAvailability::class, 'slotAvailability'],
        'adminMoveAvailability' => [SlotAvailability::class, 'slotAvailability'],
        'create' => [BookingLifecycle::class, 'lifecycle'],
        'adminMutate' => [BookingLifecycle::class, 'lifecycle'],
        'adminQuery' => [BookingAdminReader::class, 'adminReader'],
        'adminSummary' => [BookingAdminReader::class, 'adminReader'],
        'adminAvailability' => [AvailabilityAdministration::class, 'availabilityAdministration'],
        'adminReplaceWeeklyAvailability' => [AvailabilityAdministration::class, 'availabilityAdministration'],
        'adminMutateAvailabilityException' => [AvailabilityAdministration::class, 'availabilityAdministration'],
    ];

    /**
     * A preserved rule and the single class that may own it.
     *
     * @var array<string, class-string>
     */
    private const RULE_OWNERS = [
        'requireActive' => BookingServiceCatalog::class,
        'requestedSlot' => SlotAvailability::class,
        'assertRange' => SlotAvailability::class,
        'utcDayRange' => SlotAvailability::class,
        'slotPayload' => SlotAvailability::class,
        'compute' => SlotAvailability::class,
        'assertNotStale' => BookingLifecycle::class,
        'changedCustomerFields' => BookingLifecycle::class,
        'updateCustomer' => BookingLifecycle::class,
        'move' => BookingLifecycle::class,
        'cancel' => BookingLifecycle::class,
        'adminBookingPayload' => BookingPayloads::class,
        'publicBookingPayload' => BookingPayloads::class,
        'expectedUpdatedAt' => BookingRequestFields::class,
        'databaseInstant' => BookingRequestFields::class,
        'requiredString' => BookingRequestFields::class,
        'pageMeta' => BookingAdminReader::class,
        'summaryEntryFromRow' => BookingAdminReader::class,
        'historyCursorEventId' => BookingAdminReader::class,
        'submittedWindows' => AvailabilityAdministration::class,
        'weeklyRulePayload' => AvailabilityAdministration::class,
        'exceptionPayload' => AvailabilityAdministration::class,
        'minutePrecision' => AvailabilityAdministration::class,
    ];

    public function testTheBookingApiSurfaceIsTheFrozenTenMethods(): void
    {
        $interface = array_map(
            static fn (\ReflectionMethod $method): string => $method->getName(),
            (new \ReflectionClass(BookingApi::class))->getMethods(),
        );
        $expected = self::API_METHODS;
        sort($interface);
        sort($expected);

        self::assertSame($expected, $interface);

        foreach (self::API_METHODS as $method) {
            self::assertTrue(
                (new \ReflectionClass(PdoBookingApi::class))->hasMethod($method),
                "PdoBookingApi no longer implements BookingApi::{$method}().",
            );
        }
    }

    public function testTheFacadeIsThinAndDelegatesEveryMethodOnce(): void
    {
        $reflection = new \ReflectionClass(PdoBookingApi::class);
        $methods = array_map(
            static fn (\ReflectionMethod $method): string => $method->getName(),
            $reflection->getMethods(\ReflectionMethod::IS_PUBLIC),
        );
        sort($methods);

        // The façade owns no rule of its own: constructor + createDefault +
        // the ten delegates, nothing else public, nothing private.
        $expected = self::API_METHODS;
        $expected[] = '__construct';
        $expected[] = 'createDefault';
        sort($expected);
        self::assertSame($expected, $methods);
        self::assertSame([], $reflection->getMethods(\ReflectionMethod::IS_PRIVATE));

        $source = (string) file_get_contents(\dirname(__DIR__, 2) . '/src/Booking/PdoBookingApi.php');
        foreach (self::DELEGATIONS as $method => [, $property]) {
            // The delegate is one statement: return $this-><property>->method(...).
            $delegate = "return \$this->{$property}->{$method}(";
            self::assertSame(
                1,
                substr_count($source, $delegate),
                "Expected exactly one {$delegate}... delegate in PdoBookingApi.",
            );

            // And each delegate body stays a one-liner (thin façade bound).
            $span = $reflection->getMethod($method)->getEndLine() - $reflection->getMethod($method)->getStartLine();
            self::assertLessThanOrEqual(6, $span, "BookingApi::{$method}() is no longer a thin delegate.");
        }
    }

    public function testEveryCollaboratorOwnsItsExactSliceOfTheSurface(): void
    {
        // Public use-case slice of each collaborator (constructor excluded).
        $expectedSurfaces = [
            BookingServiceCatalog::class => ['services', 'requireActive'],
            SlotAvailability::class => [
                'availability',
                'adminMoveAvailability',
                'requestedSlot',
                'assertRange',
                'utcDayRange',
            ],
            BookingLifecycle::class => ['create', 'adminMutate'],
            BookingAdminReader::class => ['adminQuery', 'adminSummary'],
            AvailabilityAdministration::class => [
                'adminAvailability',
                'adminReplaceWeeklyAvailability',
                'adminMutateAvailabilityException',
            ],
        ];

        foreach ($expectedSurfaces as $class => $publicMethods) {
            $methods = array_map(
                static fn (\ReflectionMethod $method): string => $method->getName(),
                (new \ReflectionClass($class))->getMethods(\ReflectionMethod::IS_PUBLIC),
            );
            sort($methods);
            $expected = $publicMethods;
            $expected[] = '__construct';
            sort($expected);
            self::assertSame($expected, $methods, "Unexpected public surface on {$class}.");
        }
    }

    public function testEachPreservedRuleHasExactlyOneOwner(): void
    {
        // All owners are among these classes; anything not in the map would
        // leave the single-owner assertion blind.
        $collaborators = [
            BookingServiceCatalog::class,
            SlotAvailability::class,
            BookingLifecycle::class,
            BookingAdminReader::class,
            AvailabilityAdministration::class,
            BookingPayloads::class,
            BookingRequestFields::class,
            PdoBookingApi::class,
        ];

        foreach (self::RULE_OWNERS as $rule => $owner) {
            foreach ($collaborators as $class) {
                $has = (new \ReflectionClass($class))->hasMethod($rule);
                if ($class === $owner) {
                    self::assertTrue($has, "{$owner} no longer owns the {$rule} rule.");
                } else {
                    self::assertFalse($has, "{$rule} is duplicated into {$class}.");
                }
            }
        }
    }

    public function testCreateDefaultWiresTheWholeGraphWithoutAnyDatabase(): void
    {
        // Database opens no connection until the first query (ESZ-013), so the
        // production wiring itself is provable without a server: an unreachable
        // DSN would fail the first statement, never the assembly.
        $api = PdoBookingApi::createDefault(
            new Database(new DatabaseSettings(
                'mysql:host=127.0.0.1;port=1;dbname=esz106_composition_test;charset=utf8mb4',
                'eszter',
                'eszter',
                1,
            )),
            new FrozenClock('2026-06-13T12:00:00.000Z'),
            BookingDomainContract::fromArtifacts(TestEnvironment::artifacts()),
            NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
        );

        self::assertInstanceOf(BookingApi::class, $api);

        $propertyTypes = [
            'serviceCatalog' => BookingServiceCatalog::class,
            'slotAvailability' => SlotAvailability::class,
            'lifecycle' => BookingLifecycle::class,
            'adminReader' => BookingAdminReader::class,
            'availabilityAdministration' => AvailabilityAdministration::class,
        ];
        foreach ($propertyTypes as $property => $type) {
            $reflected = new \ReflectionProperty(PdoBookingApi::class, $property);
            self::assertSame($type, (string) $reflected->getType(), "Unexpected {$property} wiring.");
        }
    }
}
