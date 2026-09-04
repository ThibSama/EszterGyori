#!/usr/bin/env php
<?php

/**
 * Daily bounded retention for the repository-owned application logs (ESZ-141).
 *
 * Hetzner production command:
 *   cd /usr/home/<FTP_LOGIN>/eszter/app && /usr/bin/php bin/maintain-logs.php \
 *       --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php
 *
 * Exit codes: 0 success, 1 unsafe or operational failure, 2 usage error.
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Config\Configuration;
use Eszter\Config\ConfigurationException;
use Eszter\Support\CommandOptions;
use Eszter\Support\LogMaintenance;
use Eszter\Support\LogMaintenanceException;
use Eszter\Support\SystemClock;

require_once __DIR__ . '/../vendor/autoload.php';

/** @param list<string> $arguments */
function maintainLogsMain(array $arguments): int
{
    $options = CommandOptions::parse($arguments);
    foreach (\array_slice($arguments, 1) as $argument) {
        if ($argument !== '--help' && preg_match('/^--config=.+$/D', $argument) !== 1) {
            fwrite(STDERR, "maintain-logs: invalid argument.\n");

            return 2;
        }
    }
    if ($options->flag('help')) {
        maintainLogsUsage();

        return 0;
    }

    $configPath = $options->value('config');
    if ($configPath === null) {
        fwrite(STDERR, "maintain-logs: --config=PATH is required.\n");

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $result = (new LogMaintenance($config->logDir, new SystemClock()))->run();
    } catch (ConfigurationException $exception) {
        fwrite(STDERR, 'maintain-logs: ' . $exception->getMessage() . "\n");

        return 1;
    } catch (LogMaintenanceException $exception) {
        fwrite(STDERR, 'maintain-logs: ' . $exception->getMessage() . "\n");

        return 1;
    } catch (\Throwable) {
        fwrite(STDERR, "maintain-logs: maintenance failed safely.\n");

        return 1;
    }

    foreach ($result['rotated'] as $path) {
        fwrite(STDOUT, "rotated: {$path}\n");
    }
    foreach ($result['deleted'] as $path) {
        fwrite(STDOUT, "deleted: {$path}\n");
    }
    fwrite(STDOUT, \sprintf(
        "maintain-logs: PASS (%d rotated, %d deleted; retention %d days)\n",
        \count($result['rotated']),
        \count($result['deleted']),
        LogMaintenance::RETENTION_DAYS,
    ));

    return 0;
}

function maintainLogsUsage(): void
{
    fwrite(STDOUT, "Usage: php bin/maintain-logs.php --config=PATH\n");
}

/** @var list<string> $argv */
exit(maintainLogsMain($argv));
