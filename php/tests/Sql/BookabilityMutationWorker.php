<?php

declare(strict_types=1);

use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingSerializationLock;
use Eszter\Booking\PdoBookingApi;
use Eszter\Notification\NotificationPolicy;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Sql\TestDatabase;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * One bookability mutation driven through the real application service in its
 * own process (ESZ-146).
 *
 * The mutation owns a transaction and acquires the shared
 * `booking_resource_locks.primary` boundary as its first statement — exactly
 * like a booking create/move would — so the test can prove which side of the
 * boundary went first without timing sleeps: the test parks this worker behind
 * a parent-held row lock and releases the boundary in the chosen order.
 *
 * Usage:
 *   php BookabilityMutationWorker.php close <localDate> <readyPath>
 *   php BookabilityMutationWorker.php replace-weekly <weekdayIso> <startLocal> <endLocal> <readyPath>
 *   php BookabilityMutationWorker.php provision <key> <duration> <before> <after> <active> <readyPath>
 *
 * stdout carries `OK <mode>` on success, `FAILED <ExceptionClass>` on refusal
 * (message on stderr); the exit code is 0 on success, 1 on refusal.
 *
 * @var list<string> $argv
 */
$mode = $argv[1] ?? '';
$readyPath = match ($mode) {
    'close' => $argv[3] ?? '',
    'replace-weekly' => $argv[5] ?? '',
    'provision' => $argv[7] ?? '',
    default => '',
};

if ($readyPath === '') {
    fwrite(STDERR, "worker arguments missing\n");
    exit(2);
}

try {
    $clock = new FrozenClock('2026-06-13T12:00:00.000Z');
    $contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
    $api = PdoBookingApi::createDefault(
        TestDatabase::connectSeparately(),
        $clock,
        $contract,
        NotificationPolicy::fromArtifacts(TestEnvironment::artifacts()),
    );
    $serviceDatabase = TestDatabase::connectSeparately();
    $services = new BookableServiceRepository(
        $serviceDatabase,
        $clock,
        $contract,
        new BookingSerializationLock($serviceDatabase),
    );

    if (!touch($readyPath)) {
        throw new RuntimeException('worker could not signal readiness');
    }

    $head = static fn (): int => (int) $api->adminAvailability([
        'fromDate' => '2026-06-01',
        'untilDate' => '2026-06-30',
    ])['revision'];

    if ($mode === 'close') {
        $api->adminMutateAvailabilityException([
            'expectedRevision' => $head(),
            'action' => 'close',
            'localDate' => $argv[2],
            'note' => 'ESZ-146 concurrent closure',
        ]);
    } elseif ($mode === 'replace-weekly') {
        $api->adminReplaceWeeklyAvailability([
            'expectedRevision' => $head(),
            'rules' => [[
                'weekdayIso' => (int) $argv[2],
                'startLocal' => $argv[3],
                'endLocal' => $argv[4],
                'foldUtcOffset' => null,
                'validFrom' => null,
                'validUntil' => null,
                'isActive' => true,
            ]],
        ]);
    } elseif ($mode === 'provision') {
        $services->provision(
            $argv[2],
            'Sourcils',
            (int) $argv[3],
            (int) $argv[4],
            (int) $argv[5],
            $argv[6] === '1',
        );
    } else {
        throw new RuntimeException('unknown mutation mode');
    }

    fwrite(STDOUT, 'OK ' . $mode . "\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    fwrite(STDOUT, 'FAILED ' . $exception::class . "\n");
    exit(1);
}
