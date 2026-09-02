#!/usr/bin/env php
<?php

/**
 * Explicit, repeat-safe bookable-service provisioning (ESZ-041).
 *
 * No migration and no application boot creates booking configuration. An
 * operator supplies the stable SiteContent key and every operational value:
 *
 * php bin/provision-booking-service.php --config=config/config.php --key=brows \
 *   --label="Sourcils" --duration=120 --buffer-before=15 --buffer-after=15
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingSerializationLock;
use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Support\SystemClock;

require_once __DIR__ . '/../vendor/autoload.php';

/** @param list<string> $arguments */
function bookingServiceMain(array $arguments): int
{
    $options = bookingServiceOptions($arguments);

    if (isset($options['help'])) {
        bookingServiceUsage();

        return 0;
    }

    foreach (['config', 'key', 'label', 'duration', 'buffer-before', 'buffer-after'] as $required) {
        if (!isset($options[$required]) || $options[$required] === '') {
            fwrite(STDERR, "provision-booking-service: --{$required}=VALUE is required.\n");

            return 2;
        }
    }

    $configPath = $options['config'];
    $key = $options['key'];
    $label = $options['label'];

    if (!\is_string($configPath) || !\is_string($key) || !\is_string($label)) {
        fwrite(STDERR, "provision-booking-service: option values must be strings.\n");

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $artifacts = new ContractArtifacts($config->contractsDir);
        $artifacts->verifyAll();
        $clock = new SystemClock();
        $database = new Database($config->requireDatabase(), $config->lockDir);
        $repository = new BookableServiceRepository(
            $database,
            $clock,
            BookingDomainContract::fromArtifacts($artifacts),
            new BookingSerializationLock($database),
        );

        $result = $repository->provision(
            $key,
            $label,
            bookingServiceInteger($options, 'duration'),
            bookingServiceInteger($options, 'buffer-before'),
            bookingServiceInteger($options, 'buffer-after'),
            !isset($options['disable']),
        );

        fwrite(STDOUT, \sprintf(
            "%s %s (%d min, %d/%d min buffers, %s).\n",
            $result['created'] ? 'Created' : 'Updated',
            $result['service']->key,
            $result['service']->durationMinutes,
            $result['service']->bufferBeforeMinutes,
            $result['service']->bufferAfterMinutes,
            $result['service']->isActive ? 'active' : 'inactive',
        ));

        return 0;
    } catch (\InvalidArgumentException $exception) {
        fwrite(STDERR, 'provision-booking-service: ' . $exception->getMessage() . "\n");

        return 2;
    } catch (\Throwable $exception) {
        fwrite(STDERR, 'provision-booking-service: ' . $exception->getMessage() . "\n");

        return 1;
    }
}

/**
 * @param list<string> $arguments
 * @return array<string, string|true>
 */
function bookingServiceOptions(array $arguments): array
{
    $options = [];
    foreach (array_slice($arguments, 1) as $argument) {
        if ($argument === '--help' || $argument === '--disable') {
            $options[substr($argument, 2)] = true;
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
function bookingServiceInteger(array $options, string $key): int
{
    $value = $options[$key] ?? null;
    if (!\is_string($value) || preg_match('/^\d+$/', $value) !== 1) {
        throw new \InvalidArgumentException("--{$key} must be a non-negative integer.");
    }

    return (int) $value;
}

function bookingServiceUsage(): void
{
    fwrite(STDOUT, "Usage: php bin/provision-booking-service.php --config=PATH --key=KEY \\\n");
    fwrite(STDOUT, "  --label=LABEL --duration=MIN --buffer-before=MIN --buffer-after=MIN [--disable]\n");
}

/** @var list<string> $argv */
exit(bookingServiceMain($argv));
