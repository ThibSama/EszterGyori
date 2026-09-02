<?php

declare(strict_types=1);

use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\PdoBookingApi;
use Eszter\Notification\NotificationPolicy;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Sql\TestDatabase;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * A booking create or move driven through the real application service in its
 * own process (ESZ-146).
 *
 * It exists for the same reason {@see AvailabilityReplacementWorker} does: the
 * property under test is what a *different* connection observes while a
 * bookability mutation is in flight, and a single connection cannot demonstrate
 * that — it would see its own uncommitted writes, and blocking on its own lock
 * would simply deadlock the test.
 *
 * The worker signals readiness and then blocks inside
 * `PdoBookingApi::create()` / `adminMutate(move)` on the shared
 * `booking_resource_locks.primary` boundary if another transaction owns it.
 * The test decides who owns the boundary first and asserts on the outcome.
 *
 * Usage:
 *   php BookingMutationWorker.php create <serviceKey> <startsAtUtc> <readyPath>
 *   php BookingMutationWorker.php move <reference> <startsAtUtc> <readyPath>
 *
 * stdout carries the outcome: `CONFIRMED <reference>` / `MOVED <reference>` on
 * success, `FAILED <ExceptionClass>` on the expected domain refusal. The
 * message goes to stderr; the exit code is 1 on any refusal.
 *
 * @var list<string> $argv
 */
$operation = $argv[1] ?? '';
$first = $argv[2] ?? '';
$second = $argv[3] ?? '';
$readyPath = $argv[4] ?? '';

if (!\in_array($operation, ['create', 'move'], true) || $readyPath === '') {
    fwrite(STDERR, "worker arguments missing\n");
    exit(2);
}

try {
    $api = PdoBookingApi::createDefault(
        TestDatabase::connectSeparately(),
        new FrozenClock('2026-06-13T12:00:00.000Z'),
        BookingDomainContract::fromArtifacts(TestEnvironment::artifacts()),
        NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
    );

    if (!touch($readyPath)) {
        throw new RuntimeException('worker could not signal readiness');
    }

    if ($operation === 'create') {
        $booking = $api->create([
            'serviceKey' => $first,
            'startsAtUtc' => $second,
            'customerName' => 'Concurrent acceptance client',
            'customerEmail' => 'concurrent@example.test',
            'customerPhone' => null,
            'customerNote' => null,
            'consentAccepted' => true,
        ]);
        fwrite(STDOUT, 'CONFIRMED ' . $booking['reference'] . "\n");
    } else {
        $moved = $api->adminMutate([
            'action' => 'move',
            'reference' => $first,
            'startsAtUtc' => $second,
        ]);
        fwrite(STDOUT, 'MOVED ' . $moved['booking']['reference'] . "\n");
    }

    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    fwrite(STDOUT, 'FAILED ' . $exception::class . "\n");
    exit(1);
}
