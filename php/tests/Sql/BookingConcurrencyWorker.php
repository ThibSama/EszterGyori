<?php

declare(strict_types=1);

use Eszter\Http\Request;
use Eszter\Kernel;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Sql\TestDatabase;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/** @var list<string> $argv */
$serviceKey = $argv[1] ?? '';
$readyPath = $argv[2] ?? '';

if ($serviceKey === '' || $readyPath === '') {
    fwrite(STDERR, "worker arguments missing\n");
    exit(2);
}

try {
    $clock = new FrozenClock('2026-06-13T12:00:00.000Z');
    $root = TestEnvironment::makeTempDirectory('eszter-booking-client');
    $database = TestDatabase::settings();
    $config = TestEnvironment::writeDeployment($root, [
        'database' => [
            'dsn' => $database->dsn,
            'username' => $database->username,
            'password' => $database->password,
            'connectTimeoutSeconds' => $database->connectTimeoutSeconds,
        ],
        'session' => ['cookieSecure' => false],
    ]);
    TestEnvironment::writeExportedPage($root);
    // Boot the same Kernel wiring used by public/api/index.php. Each worker has
    // its own configuration, database connection and request object: the only
    // shared state is the disposable MySQL database production also relies on.
    $kernel = Kernel::boot($config, $clock);

    if (!touch($readyPath)) {
        throw new RuntimeException('worker could not signal readiness');
    }

    $payload = [
        'serviceKey' => $serviceKey,
        'startsAtUtc' => '2026-06-15T07:00:00.000Z',
        'customerName' => 'Concurrent acceptance client',
        'customerEmail' => 'concurrent@example.test',
        'customerPhone' => null,
        'customerNote' => null,
        'consentAccepted' => true,
    ];
    $response = $kernel->handle(new Request(
        'POST',
        '/api/bookings',
        ['content-type' => 'application/json', 'accept' => 'application/json'],
        (string) json_encode($payload),
        [],
        '192.0.2.' . ($argv[3] ?? '1'),
    ));
    $body = $response->decodedBody();
    $outcome = $response->status === 201
        ? 'CONFIRMED ' . ($body['reference'] ?? '')
        : $response->status . ' ' . ($body['error']['code'] ?? 'UNKNOWN');
    fwrite(STDOUT, $outcome . "\n");
    TestEnvironment::removeDirectory($root);
    exit(0);
} catch (Throwable $exception) {
    if (isset($root)) {
        TestEnvironment::removeDirectory($root);
    }
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
