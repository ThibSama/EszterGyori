<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Http\Request;
use Eszter\Kernel;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-105 architecture proofs: the route surface a boot exposes depends only
 * on the frozen registration conditions — whether a database is configured
 * and which seams were injected — never on where the endpoints are composed.
 *
 * The kernel no longer constructs endpoint classes itself: five dedicated
 * composition classes own each surface ({@see PublicRoutes},
 * {@see AuthRoutes}, {@see AdminContentRoutes}, {@see AdminMediaRoutes},
 * {@see BookingRoutes}). These tests pin the *observable* contract of that
 * split: the same wiring modes must register the same paths as before the
 * split, in every combination the test seams allow.
 */
final class KernelCompositionTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-composition');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    /**
     * A database block whose DSN can never be reached. Boot is lazy by design
     * (ESZ-013): `Database` opens no connection until the first query, so the
     * full production wiring mode is exercisable without a server.
     *
     * @return array<string, mixed>
     */
    private static function unreachableDatabase(): array
    {
        return [
            'database' => [
                'dsn' => 'mysql:host=127.0.0.1;port=1;dbname=eszter_composition_test;charset=utf8mb4',
                'username' => 'eszter',
                'password' => 'eszter',
                'connectTimeoutSeconds' => 1,
            ],
        ];
    }

    /** @param array<string, mixed> $overrides */
    private function boot(
        array $overrides = [],
        ?InMemoryAccountDirectory $accounts = null,
        ?InMemorySessionStore $sessions = null,
        bool $bookingApi = false,
    ): Kernel {
        $clock = new FrozenClock('2026-06-13T12:00:00.000Z');

        return Kernel::boot(
            TestEnvironment::writeDeployment($this->root, $overrides),
            $clock,
            null,
            null,
            $accounts,
            $sessions,
            null,
            $bookingApi ? new InMemoryBookingApi() : null,
        );
    }

    /** @return list<string> Every path the http-contract freezes as routed. */
    private static function contractedPaths(): array
    {
        /** @var list<array<string, mixed>> $endpoints */
        $endpoints = TestEnvironment::artifacts()->httpContract()['endpoints'];
        $paths = [];

        foreach ($endpoints as $endpoint) {
            /** @var string $path */
            $path = $endpoint['path'];
            $paths[] = $path;
        }

        $paths = array_values(array_unique($paths));
        sort($paths);

        return $paths;
    }

    /** @param list<string> $expected */
    private static function assertRoutes(Kernel $kernel, array $expected): void
    {
        $routed = $kernel->router->paths();
        sort($routed);

        self::assertSame($expected, $routed);
    }

    public function testBootWithoutDatabaseRegistersOnlyThePublicSurface(): void
    {
        // The frozen no-database mode: health, content and the exported page,
        // and nothing else — `/api/auth/*` and `/api/admin/*` stay at their
        // structured 404 until a session store exists (KernelBootTest freezes
        // the same list in the boot log line).
        self::assertRoutes(
            $this->boot(),
            ['/', '/api/content', '/api/health'],
        );
    }

    public function testBootWithConfiguredDatabaseWiringRegistersTheWholeFrozenSurface(): void
    {
        // Real SQL wiring decided by configuration alone: with a database
        // block the kernel builds its own account directory, session store and
        // booking implementation, so every contracted surface exists — without
        // a single query (boot is lazy).
        self::assertRoutes(
            $this->boot(self::unreachableDatabase()),
            self::contractedPaths(),
        );
    }

    public function testSeamWiringRegistersExactlyTheSameSurfaceAsConfiguredDatabaseWiring(): void
    {
        // The conformance replay mode: every seam injected, no database. The
        // surface must be identical to the configured-database mode above —
        // the seams replace the persistence, never the route set (ESZ-015).
        $clock = new FrozenClock('2026-06-13T12:00:00.000Z');
        $kernel = $this->boot(
            [],
            InMemoryAccountDirectory::withAccount(true),
            new InMemorySessionStore($clock),
            true,
        );

        self::assertRoutes($kernel, self::contractedPaths());

        $configured = $this->boot(self::unreachableDatabase());
        $seamPaths = $kernel->router->paths();
        sort($seamPaths);
        self::assertRoutes($configured, $seamPaths);
    }

    public function testAnAccountDirectoryWithoutASessionStoreAddsOnlyThePublicBookingSurface(): void
    {
        // The one asymmetric seam combination the composition conditions
        // allow: a booking implementation exists (so the public booking
        // routes are registered) but no session store exists (so no
        // authenticated surface is — admin booking included).
        $kernel = $this->boot(
            [],
            InMemoryAccountDirectory::withAccount(true),
            null,
            true,
        );

        self::assertRoutes(
            $kernel,
            [
                '/',
                '/api/booking/availability',
                '/api/booking/services',
                '/api/bookings',
                '/api/content',
                '/api/health',
            ],
        );
    }

    public function testTheBootedKernelStillOwnsTheRequestLifecycle(): void
    {
        // handle() and its guards are untouched by the split: an unknown path
        // is still the structured 404 envelope, answered through the same
        // kernel object the composers registered onto.
        $kernel = $this->boot(self::unreachableDatabase());

        $notFound = $kernel->handle(new Request('GET', '/api/unknown'));
        $body = $notFound->decodedBody();

        self::assertSame(404, $notFound->status);
        self::assertIsArray($body);
        self::assertSame('NOT_FOUND', $body['error']['code'] ?? null);
    }
}
