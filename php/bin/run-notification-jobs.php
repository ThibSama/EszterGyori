#!/usr/bin/env php
<?php

/**
 * The notification cron runner (ESZ-071).
 *
 * One tick: recover expired leases, retire stale reminders, claim a bounded
 * batch, deliver each job outside any transaction. Designed to be run from cron
 * as often as makes sense — every minute is fine — and to be safe when two ticks
 * overlap, because on a shared host they eventually will.
 *
 * Hetzner production command (one exclusive job, every minute):
 *   cd /usr/home/<FTP_LOGIN>/eszter/app && /usr/bin/php bin/run-notification-jobs.php \
 *       --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php --transport=smtp
 * See docs/deployment-runbook.md for the hosting-panel settings and log path.
 *
 * Usage:
 *   php bin/run-notification-jobs.php --config=PATH [--batch=N] [--transport=smtp]
 *
 * Exit codes:
 *   0  the tick completed (including "there was nothing to do")
 *   1  an operational failure — database, contract artifacts, configuration
 *   2  a usage error
 *   3  an enabled channel has no registered transport; nothing was claimed
 *
 * ## About `--transport`
 *
 * `smtp` is the production default from Package 7.2. `logging` remains an
 * explicit no-network development/test aid and is refused in production, so a
 * successful production tick cannot silently mean that no e-mail left the host.
 * No SMS transport is implemented.
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Booking\BookingDomainContract;
use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Notification\BookingEmailRenderer;
use Eszter\Notification\BookingNotificationFactsRepository;
use Eszter\Notification\LoggingNotificationTransport;
use Eszter\Notification\NotificationChannelSettings;
use Eszter\Notification\NotificationException;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\NotificationPolicy;
use Eszter\Notification\NotificationRunner;
use Eszter\Notification\NotificationTransportRegistry;
use Eszter\Notification\SmtpNotificationTransport;
use Eszter\Support\Logger;
use Eszter\Support\SystemClock;

require_once __DIR__ . '/../vendor/autoload.php';

/** @param list<string> $arguments */
function notificationRunnerMain(array $arguments): int
{
    try {
        $options = notificationRunnerOptions($arguments);
    } catch (\InvalidArgumentException $exception) {
        fwrite(STDERR, 'run-notification-jobs: ' . $exception->getMessage() . "\n");

        return 2;
    }

    if (isset($options['help'])) {
        notificationRunnerUsage();

        return 0;
    }

    $configPath = $options['config'] ?? null;
    if (!\is_string($configPath) || $configPath === '') {
        fwrite(STDERR, "run-notification-jobs: --config=PATH is required.\n");

        return 2;
    }

    $transportName = $options['transport'] ?? 'smtp';
    if (!\in_array($transportName, ['smtp', 'logging'], true)) {
        fwrite(STDERR, "run-notification-jobs: --transport must be smtp or logging.\n");

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $artifacts = new ContractArtifacts($config->contractsDir);
        $artifacts->verifyAll();

        $policy = NotificationPolicy::fromArtifacts($artifacts);
        // Loaded but unused directly: it is what proves the artifacts this run
        // reads are the same generation the booking domain was built from, and
        // it fails loudly here rather than at the first job.
        BookingDomainContract::fromArtifacts($artifacts);

        $batch = notificationRunnerBatch($options, $policy->defaultBatchSize);
        if ($batch < 1 || $batch > $policy->maxBatchSize) {
            fwrite(STDERR, "run-notification-jobs: --batch must be between 1 and {$policy->maxBatchSize}.\n");

            return 2;
        }

        $clock = new SystemClock();
        $database = new Database($config->requireDatabase());
        $logger = new Logger(
            rtrim($config->logDir, '/') . '/notifications.log',
            $config->logLevel,
            $clock,
        );

        $registry = new NotificationTransportRegistry($policy);
        if ($transportName === 'logging') {
            if ($config->isProduction()) {
                throw NotificationException::invalid(
                    'transport',
                    'logging transport is restricted to development and test environments.',
                );
            }
            foreach ($policy->channels as $channel) {
                $registry->register(new LoggingNotificationTransport($channel, $logger, $policy));
            }
            fwrite(STDERR, "run-notification-jobs: transport=logging — no message leaves this host.\n");
        } else {
            $smtp = $config->requireSmtp();
            $registry->register(new SmtpNotificationTransport(
                $smtp,
                new BookingNotificationFactsRepository($database),
                new BookingEmailRenderer($smtp),
            ));
        }

        $runner = new NotificationRunner(
            new NotificationJobRepository($database, $clock, $policy),
            $registry,
            new NotificationChannelSettings($database, $clock, $policy),
            $policy,
            $logger,
        );

        $owner = NotificationRunner::ownerFor((string) gethostname(), getmypid() ?: 0);
        $result = $runner->run($owner, $batch);

        fwrite(STDOUT, $result->describe() . "\n");

        return 0;
    } catch (NotificationException $exception) {
        // The one NotificationException an operator can actually act on is the
        // missing transport, and it gets its own exit code so cron alerting can
        // distinguish "misconfigured" from "the database is down".
        $missingTransport = str_contains($exception->getMessage(), 'no transport is registered');
        fwrite(STDERR, 'run-notification-jobs: ' . $exception->getMessage() . "\n");

        return $missingTransport ? 3 : 1;
    } catch (\Throwable $exception) {
        // The message, not the trace: a stack trace from a PDO failure carries
        // the DSN, and this stream may well be a cron mail.
        fwrite(STDERR, 'run-notification-jobs: ' . $exception->getMessage() . "\n");

        return 1;
    }
}

/**
 * @param list<string> $arguments
 * @return array<string, string|true>
 */
function notificationRunnerOptions(array $arguments): array
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
function notificationRunnerBatch(array $options, int $default): int
{
    $value = $options['batch'] ?? null;

    if ($value === null) {
        return $default;
    }

    if (!\is_string($value) || preg_match('/^\d{1,4}$/', $value) !== 1) {
        return 0;
    }

    return (int) $value;
}

function notificationRunnerUsage(): void
{
    fwrite(STDOUT, "Usage: php bin/run-notification-jobs.php --config=PATH [--batch=N] [--transport=smtp]\n");
    fwrite(STDOUT, "  --batch      jobs to claim this tick; defaults to the frozen batch size\n");
    fwrite(STDOUT, "  --transport  smtp (default), or logging in development/test only\n");
}

/** @var list<string> $argv */
exit(notificationRunnerMain($argv));
