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
 * A booking create or admin mutation driven through the real application
 * service in its own process (ESZ-146 / ESZ-139).
 *
 * It exists for the same reason {@see AvailabilityReplacementWorker} does: the
 * property under test is what a *different* connection observes while another
 * mutation is in flight, and a single connection cannot demonstrate that — it
 * would see its own uncommitted writes, and blocking on its own lock would
 * simply deadlock the test.
 *
 * The worker signals readiness and then blocks inside
 * `PdoBookingApi::create()` / `adminMutate()` on the shared
 * `booking_resource_locks.primary` boundary and/or the booking row lock if
 * another transaction owns them. The test decides who owns the locks first
 * and asserts on the outcome.
 *
 * Admin mutations (ESZ-139) send `expectedUpdatedAt`. When the caller passes
 * it as an argument the worker replays exactly that token — the stale-editor
 * case; when the argument is absent the worker reads the booking's current
 * `updatedAt` itself before signalling readiness, like a fresh client would.
 *
 * Usage (the readiness path is always the last argument):
 *   php BookingMutationWorker.php create <serviceKey> <startsAtUtc> <readyPath>
 *   php BookingMutationWorker.php move <reference> <startsAtUtc> [<expectedUpdatedAt>] <readyPath>
 *   php BookingMutationWorker.php update <reference> <customerName> [<expectedUpdatedAt>] <readyPath>
 *   php BookingMutationWorker.php cancel <reference> <reason|-|> [<expectedUpdatedAt>] <readyPath>
 *
 * stdout carries the outcome: `CONFIRMED <reference>` / `MOVED <reference>` /
 * `UPDATED <reference>` / `CANCELLED <reference>` on success, `FAILED
 * <ExceptionClass>` on the expected domain refusal. The message goes to
 * stderr; the exit code is 1 on any refusal.
 *
 * @var list<string> $argv
 */
$arguments = array_slice($argv, 1);
$readyPath = (string) array_pop($arguments);
$operation = $arguments[0] ?? '';

if (!in_array($operation, ['create', 'move', 'update', 'cancel'], true) || $readyPath === '') {
    fwrite(STDERR, "worker arguments missing\n");
    exit(2);
}

try {
    $contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
    $api = PdoBookingApi::createDefault(
        TestDatabase::connectSeparately(),
        new FrozenClock('2026-06-13T12:00:00.000Z'),
        $contract,
        NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
    );

    if ($operation === 'create') {
        if (!touch($readyPath)) {
            throw new RuntimeException('worker could not signal readiness');
        }

        $booking = $api->create([
            'serviceKey' => $arguments[1] ?? '',
            'startsAtUtc' => $arguments[2] ?? '',
            'customerName' => 'Concurrent acceptance client',
            'customerEmail' => 'concurrent@example.test',
            'customerPhone' => null,
            'customerNote' => null,
            // ESZ-142: the catalog's current consent notice id, resolved from
            // the same artifacts the API validates membership against.
            'consentNoticeId' => $contract->currentConsentNoticeId,
            'consentAccepted' => true,
        ]);
        fwrite(STDOUT, 'CONFIRMED ' . $booking['reference'] . "\n");
        exit(0);
    }

    /** @var string $reference */
    $reference = $arguments[1] ?? '';
    // ESZ-139: the token is the optional argument right before the readiness
    // path (`move <ref> <target> [token]`, `update <ref> <name> [token]`,
    // `cancel <ref> <reason|-> [token]`). When the caller omits it, the worker
    // reads the row's current updatedAt before signalling readiness — the
    // fresh-client spelling.
    $expectedUpdatedAt = $arguments[3] ?? null;
    if ($expectedUpdatedAt === null || $expectedUpdatedAt === '') {
        $read = $api->adminQuery(['mode' => 'reference', 'reference' => $reference]);
        $expectedUpdatedAt = (string) ($read['bookings'][0]['updatedAt'] ?? '');
    }

    if (!touch($readyPath)) {
        throw new RuntimeException('worker could not signal readiness');
    }

    // The in_array guard above already restricted $operation to these three
    // (create exited earlier), so the match is exhaustive without a default.
    $mutated = match ($operation) {
        'move' => $api->adminMutate([
            'action' => 'move',
            'reference' => $reference,
            'expectedUpdatedAt' => $expectedUpdatedAt,
            'startsAtUtc' => $arguments[2] ?? '',
        ]),
        'update' => $api->adminMutate([
            'action' => 'update',
            'reference' => $reference,
            'expectedUpdatedAt' => $expectedUpdatedAt,
            'customerName' => $arguments[2] ?? 'Worker Cliente',
            'customerEmail' => 'worker@example.test',
            'customerPhone' => null,
            'customerNote' => null,
        ]),
        'cancel' => $api->adminMutate([
            'action' => 'cancel',
            'reference' => $reference,
            'expectedUpdatedAt' => $expectedUpdatedAt,
            'reason' => ($arguments[2] ?? '') === '' ? null : $arguments[2],
        ]),
    };
    $labels = [
        'create' => 'CONFIRMED',
        'move' => 'MOVED',
        'update' => 'UPDATED',
        'cancel' => 'CANCELLED',
    ];
    fwrite(STDOUT, $labels[$operation] . ' ' . $mutated['booking']['reference'] . "\n");

    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    fwrite(STDOUT, 'FAILED ' . $exception::class . "\n");
    exit(1);
}
