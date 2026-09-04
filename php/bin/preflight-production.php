#!/usr/bin/env php
<?php

/**
 * Fail-closed host-side proof for the configured application log sink (ESZ-128).
 *
 * It loads the same Configuration as Kernel, then proves that app.log can be
 * created, opened for append, restricted to 0600, completely written and
 * flushed. A passing run leaves one context-free probe line in the real app.log.
 * This proves host prerequisites; ESZ-127 readiness proves serving dependencies.
 * They are complementary and neither substitutes for the other.
 *
 * Hetzner production command:
 *   cd /usr/home/<FTP_LOGIN>/eszter/app && /usr/bin/php bin/preflight-production.php \
 *       --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php
 *
 * Usage:
 *   php bin/preflight-production.php --config=PATH
 *
 * Exit codes:
 *   0  configuration loaded and the log sink passed every probe
 *   1  configuration or host log-sink preflight failed
 *   2  a usage error
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Config\Configuration;
use Eszter\Config\ConfigurationException;
use Eszter\Support\LogSink;
use Eszter\Support\SystemClock;

require_once __DIR__ . '/../vendor/autoload.php';

/** @param list<string> $arguments */
function productionPreflightMain(array $arguments): int
{
    try {
        $options = productionPreflightOptions($arguments);
    } catch (\InvalidArgumentException $exception) {
        fwrite(STDERR, 'preflight-production: ' . $exception->getMessage() . "\n");

        return 2;
    }

    if (isset($options['help'])) {
        productionPreflightUsage();

        return 0;
    }

    $configPath = $options['config'] ?? null;
    if (!\is_string($configPath) || $configPath === '') {
        fwrite(STDERR, "preflight-production: --config=PATH is required.\n");

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
    } catch (ConfigurationException $exception) {
        fwrite(STDERR, 'preflight-production: ' . $exception->getMessage() . "\n");

        return 1;
    } catch (\Throwable) {
        fwrite(STDERR, "preflight-production: configuration could not be loaded safely.\n");

        return 1;
    }

    $failure = (new LogSink($config->logFile()))->probe(new SystemClock());
    if ($failure !== null) {
        fwrite(STDERR, 'preflight-production: ' . $failure . "\n");

        return 1;
    }

    fwrite(STDOUT, "preflight:production PASS\n");

    return 0;
}

/**
 * @param list<string> $arguments
 * @return array<string, string|true>
 */
function productionPreflightOptions(array $arguments): array
{
    $options = [];

    foreach (\array_slice($arguments, 1) as $argument) {
        if ($argument === '--help') {
            $options['help'] = true;
            continue;
        }
        if (preg_match('/^--config=(.*)$/', $argument, $match) !== 1) {
            throw new \InvalidArgumentException("Unknown argument {$argument}.");
        }
        $options['config'] = $match[1];
    }

    return $options;
}

function productionPreflightUsage(): void
{
    fwrite(STDOUT, "Usage: php bin/preflight-production.php --config=PATH\n");
}

/** @var list<string> $argv */
exit(productionPreflightMain($argv));
