<?php

declare(strict_types=1);

use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\PdoBookingApi;
use Eszter\Support\FrozenClock;
use Eszter\Notification\NotificationPolicy;
use Eszter\Tests\Sql\TestDatabase;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * A second process that replaces the whole weekly schedule (ESZ-063).
 *
 * It exists for the same reason {@see BookingConcurrencyWorker} does: the
 * property under test is what a *different* connection observes while a
 * replacement is in flight, and a single connection cannot demonstrate that —
 * it would see its own uncommitted writes, and blocking on its own lock would
 * simply deadlock the test.
 *
 * The test holds `availability_rules` with SELECT ... FOR UPDATE, this process
 * signals readiness and then blocks inside `replaceWeeklyRules` on that exact
 * boundary, and the test reads the table while it is blocked. If the delete ran
 * before the lock, or outside a transaction, that read would find a partial or
 * empty schedule.
 *
 * @var list<string> $argv
 */
$readyPath = $argv[1] ?? '';

if ($readyPath === '') {
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

    $head = $api->adminAvailability([
        'fromDate' => '2026-06-01',
        'untilDate' => '2026-06-30',
    ]);
    $result = $api->adminReplaceWeeklyAvailability([
        'expectedRevision' => $head['revision'],
        'rules' => [
            [
                'weekdayIso' => 4,
                'startLocal' => '08:00',
                'endLocal' => '10:00',
                'foldUtcOffset' => null,
                'validFrom' => null,
                'validUntil' => null,
                'isActive' => true,
            ],
        ],
    ]);

    /** @var list<array<string, mixed>> $rules */
    $rules = $result['weeklyRules'];
    fwrite(STDOUT, 'OK ' . \count($rules) . "\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
