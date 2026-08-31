<?php

declare(strict_types=1);

use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\NotificationPolicy;
use Eszter\Notification\NotificationRunner;
use Eszter\Notification\NotificationTransportRegistry;
use Eszter\Support\SystemClock;
use Eszter\Tests\Notification\FixedEnabledChannels;
use Eszter\Tests\Sql\RecordingTransport;
use Eszter\Tests\Sql\TestDatabase;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * One independent notification runner, for the two-process concurrency proof.
 *
 * A separate operating-system process with its own connection, because that is
 * the only arrangement in which MySQL is genuinely arbitrating: two claims issued
 * from one PHP process on one connection are serialised by the connection itself
 * and would prove nothing about two cron ticks overlapping on a real host.
 *
 * Prints `CLAIMED n SENT n` so the parent can assert that exactly one of the two
 * did the work.
 */

/** @var list<string> $argv */
$readyPath = $argv[1] ?? '';

if ($readyPath === '') {
    fwrite(STDERR, "worker arguments missing\n");
    exit(2);
}

try {
    $clock = new SystemClock();
    $database = TestDatabase::connectSeparately();
    $policy = NotificationPolicy::fromArtifacts(TestEnvironment::artifacts());

    $runner = new NotificationRunner(
        new NotificationJobRepository($database, $clock, $policy),
        new NotificationTransportRegistry($policy, [new RecordingTransport('email')]),
        new FixedEnabledChannels(['email']),
        $policy,
        new Eszter\Support\Logger(sys_get_temp_dir() . '/eszter-notification-worker.log', 'error', $clock),
    );

    if (!touch($readyPath)) {
        throw new RuntimeException('worker could not signal readiness');
    }

    $owner = NotificationRunner::ownerFor('worker', getmypid() ?: 0);
    $result = $runner->run($owner, 10);

    fwrite(STDOUT, \sprintf("CLAIMED %d SENT %d\n", $result->claimed, $result->sent));
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
