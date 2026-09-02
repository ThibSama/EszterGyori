#!/usr/bin/env php
<?php

/**
 * The customer-data retention sweep (ESZ-140).
 *
 * One run erases, per the frozen V1 retention policy, the customer data of
 * bookings whose lifecycle ended long enough ago — confirmed bookings 90 days
 * after their end, cancelled bookings 90 days after their cancellation — and
 * retires every pending/processing notification job of those bookings so
 * nothing can deliver from an erased row. Booking, history and notification
 * evidence are never deleted.
 *
 * Designed to be run from cron on a schedule the operator chooses (daily is
 * fine) and to be safe when two runs overlap: each booking is erased in its
 * own transaction under its row lock, with the eligibility and the erasure
 * marker re-checked there, so a second run finds nothing left to do.
 *
 * Hetzner production command (see docs/deployment-runbook.md §4):
 *   cd /usr/home/<FTP_LOGIN>/eszter/app && /usr/bin/php bin/apply-booking-retention.php \
 *       --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php
 *
 * Usage:
 *   php bin/apply-booking-retention.php --config=PATH [--batch=N]
 *
 * Exit codes:
 *   0  the sweep completed (including "there was nothing to do")
 *   1  an operational failure — database, contract artifacts, configuration
 *   2  a usage error
 *
 * ## What this command may print or log
 *
 * Counts, the cutoff and status — nothing else. No booking reference, no
 * customer value and no address ever leaves the database through this
 * command, because the sweep's interface is counts by construction and the
 * log lines it writes carry the same allowlisted fields.
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Booking\BookingDomainContract;
use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\NotificationPolicy;
use Eszter\Retention\BookingRetentionService;
use Eszter\Retention\RetentionPolicy;
use Eszter\Support\Logger;
use Eszter\Support\SystemClock;

require_once __DIR__ . '/../vendor/autoload.php';

/** @param list<string> $arguments */
function retentionMain(array $arguments): int
{
    try {
        $options = retentionOptions($arguments);
    } catch (\InvalidArgumentException $exception) {
        fwrite(STDERR, 'apply-booking-retention: ' . $exception->getMessage() . "\n");

        return 2;
    }

    if (isset($options['help'])) {
        retentionUsage();

        return 0;
    }

    $configPath = $options['config'] ?? null;
    if (!\is_string($configPath) || $configPath === '') {
        fwrite(STDERR, "apply-booking-retention: --config=PATH is required.\n");

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $artifacts = new ContractArtifacts($config->contractsDir);
        $artifacts->verifyAll();

        $retentionPolicy = RetentionPolicy::fromArtifacts($artifacts);
        // Loaded but unused directly: it proves the artifacts this run reads
        // are the same generation the booking domain and notification policy
        // were built from, and it fails loudly here rather than at the first
        // row.
        BookingDomainContract::fromArtifacts($artifacts);
        NotificationPolicy::fromArtifacts($artifacts);

        $batch = retentionBatch($options, BookingRetentionService::DEFAULT_BATCH_SIZE);
        if ($batch < 1 || $batch > BookingRetentionService::MAX_BATCH_SIZE) {
            fwrite(STDERR, "apply-booking-retention: --batch must be between 1 and "
                . BookingRetentionService::MAX_BATCH_SIZE . ".\n");

            return 2;
        }

        $clock = new SystemClock();
        $database = new Database($config->requireDatabase(), $config->lockDir);
        $logger = new Logger(
            rtrim($config->logDir, '/') . '/retention.log',
            $config->logLevel,
            $clock,
        );

        $service = new BookingRetentionService(
            $database,
            $clock,
            $retentionPolicy,
            new NotificationJobRepository($database, $clock, NotificationPolicy::fromArtifacts($artifacts)),
        );

        $started = hrtime(true);
        $result = $service->applyEligible($batch);
        $durationMs = (int) round((hrtime(true) - $started) / 1_000_000);

        // Stdout is the operator's record and cron's mail: counts and the
        // cutoff only, never references or customer values.
        fwrite(STDOUT, "status:  completed\n");
        fwrite(STDOUT, "cutoff:  " . $result['cutoffUtc'] . "\n");
        fwrite(STDOUT, "scanned: " . $result['eligible'] . "\n");
        fwrite(STDOUT, "erased:  " . $result['erased'] . "\n");
        fwrite(STDOUT, "retired: " . $result['retired'] . "\n");

        $logger->log('info', 'retention.run.completed', [
            'status' => 'completed',
            'cutoffUtc' => $result['cutoffUtc'],
            'eligible' => $result['eligible'],
            'erased' => $result['erased'],
            'retired' => $result['retired'],
            'durationMs' => $durationMs,
        ]);

        return 0;
    } catch (\Throwable $exception) {
        // The message, never a trace: a PDO stack trace carries the DSN and
        // this stream may well be a cron mail. The sweep's own log lines are
        // count-only, so a failure is reported here once, on the way out.
        fwrite(STDERR, 'apply-booking-retention: ' . $exception->getMessage() . "\n");

        return 1;
    }
}

/**
 * @param list<string> $arguments
 * @return array<string, string|true>
 */
function retentionOptions(array $arguments): array
{
    $options = [];

    foreach (\array_slice($arguments, 1) as $argument) {
        if ($argument === '--help') {
            $options['help'] = true;
            continue;
        }
        if (preg_match('/^--([a-z-]+)=(.*)$/', $argument, $match) !== 1) {
            throw new \InvalidArgumentException("Unknown argument {$argument}.");
        }
        $options[$match[1]] = $match[2];
    }

    return $options;
}

/** @param array<string, string|true> $options */
function retentionBatch(array $options, int $default): int
{
    $value = $options['batch'] ?? null;

    if ($value === null) {
        return $default;
    }

    if (!\is_string($value) || preg_match('/^\d{1,6}$/', $value) !== 1) {
        return 0;
    }

    return (int) $value;
}

function retentionUsage(): void
{
    fwrite(STDOUT, <<<TEXT

        Usage: php bin/apply-booking-retention.php --config=PATH [--batch=N]

          --batch  bookings to process this run; defaults to 500, at most 10000.

        Erases customer data of bookings past the frozen retention period and
        retires their pending/processing notification jobs. Idempotent: a
        second run changes nothing. Prints counts and the cutoff only; never a
        booking reference or a customer value.

        TEXT);
}

/** @var list<string> $argv */
exit(retentionMain($argv));
