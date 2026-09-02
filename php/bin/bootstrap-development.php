#!/usr/bin/env php
<?php

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Admin\AdminAccountRepository;
use Eszter\Admin\AdminEmail;
use Eszter\Auth\PdoSessionStore;
use Eszter\Booking\AvailabilityRepository;
use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Support\SystemClock;

require_once __DIR__ . '/../vendor/autoload.php';

const DEVELOPMENT_ADMIN_EMAIL = 'admin@eszter.test';

/** @param list<string> $arguments */
function bootstrapDevelopmentMain(array $arguments): int
{
    try {
        $options = bootstrapDevelopmentOptions($arguments);
        if (isset($options['help'])) {
            bootstrapDevelopmentUsage();

            return 0;
        }

        $configPath = bootstrapDevelopmentRequiredOption($options, 'config');
        $credentialsPath = bootstrapDevelopmentRequiredOption($options, 'credentials-file');
        $config = Configuration::fromFile($configPath);
        if ($config->environment !== 'development') {
            throw new \RuntimeException(
                'bootstrap-development refuses to write fixtures outside the development environment.',
            );
        }

        $artifacts = new ContractArtifacts($config->contractsDir);
        $artifacts->verifyAll();
        $clock = new SystemClock();
        $database = new Database($config->requireDatabase(), $config->lockDir);
        $bookingContract = BookingDomainContract::fromArtifacts($artifacts);
        $bookingTime = new BookingTimePolicy($bookingContract);

        $credentials = bootstrapDevelopmentCredentials($credentialsPath);
        $accounts = new AdminAccountRepository($database, $clock);
        $sessions = new PdoSessionStore($database, $clock);
        $adminEmail = AdminEmail::fromString($credentials['email'], $artifacts);
        $existing = $accounts->findByEmail($adminEmail->value);
        $passwordNeedsUpdate = $existing === null
            || !password_verify($credentials['password'], $existing->passwordHash);
        $provisioned = $accounts->provision(
            $adminEmail,
            $passwordNeedsUpdate ? $credentials['password'] : null,
            true,
        );
        if ($provisioned['passwordChanged'] && !$provisioned['created']) {
            // A credentials file regenerated after a reset becomes authoritative.
            // Old sessions must not outlive the old development credential.
            $sessions->destroyForAccount($provisioned['account']->id);
        }

        $services = new BookableServiceRepository($database, $clock, $bookingContract);
        foreach (bootstrapDevelopmentServices() as $service) {
            $services->provision(
                $service['key'],
                $service['label'],
                $service['duration'],
                $service['bufferBefore'],
                $service['bufferAfter'],
                true,
            );
        }

        $availability = new AvailabilityRepository(
            $database,
            $clock,
            $bookingContract,
            $bookingTime,
        );
        $rules = [];
        for ($weekday = 1; $weekday <= 6; $weekday++) {
            $rules[] = new WeeklyAvailabilityRule(
                0,
                $weekday,
                AvailabilityWindow::create('09:00', '17:00', null, $bookingContract),
                null,
                null,
                true,
            );
        }
        $availability->replaceWeeklyRules($availability->revision(), $rules);

        fwrite(STDOUT, "Development fixtures are ready.\n");
        fwrite(STDOUT, 'Admin: ' . DEVELOPMENT_ADMIN_EMAIL . "\n");
        fwrite(STDOUT, 'Credentials file: ' . realpath($credentialsPath) . "\n");
        fwrite(STDOUT, 'Bookable services: ' . count(bootstrapDevelopmentServices()) . "\n");
        fwrite(STDOUT, 'Weekly availability rules: ' . count($rules) . "\n");

        return 0;
    } catch (\InvalidArgumentException $exception) {
        fwrite(STDERR, 'bootstrap-development: ' . $exception->getMessage() . "\n");

        return 2;
    } catch (\Throwable $exception) {
        fwrite(STDERR, 'bootstrap-development: ' . $exception->getMessage() . "\n");

        return 1;
    }
}

/**
 * @param list<string> $arguments
 * @return array<string, string|true>
 */
function bootstrapDevelopmentOptions(array $arguments): array
{
    $options = [];
    foreach (array_slice($arguments, 1) as $argument) {
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
function bootstrapDevelopmentRequiredOption(array $options, string $name): string
{
    $value = $options[$name] ?? null;
    if (!\is_string($value) || $value === '') {
        throw new \InvalidArgumentException("--{$name}=VALUE is required.");
    }

    return $value;
}

/** @return array{email: string, password: string} */
function bootstrapDevelopmentCredentials(string $path): array
{
    if (is_file($path)) {
        $raw = file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException("Could not read development credentials: {$path}");
        }
        /** @var mixed $decoded */
        $decoded = json_decode($raw, true);
        if (
            !\is_array($decoded)
            || ($decoded['email'] ?? null) !== DEVELOPMENT_ADMIN_EMAIL
            || !\is_string($decoded['password'] ?? null)
            || strlen($decoded['password']) < 24
        ) {
            throw new \RuntimeException(
                "Development credentials file is malformed; remove it and bootstrap again: {$path}",
            );
        }

        return ['email' => DEVELOPMENT_ADMIN_EMAIL, 'password' => $decoded['password']];
    }

    $directory = dirname($path);
    if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new \RuntimeException("Could not create credentials directory: {$directory}");
    }
    if (!chmod($directory, 0700)) {
        throw new \RuntimeException("Could not enforce 0700 on credentials directory: {$directory}");
    }

    $credentials = [
        'email' => DEVELOPMENT_ADMIN_EMAIL,
        'password' => bin2hex(random_bytes(18)),
    ];
    $encoded = json_encode($credentials, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($encoded === false) {
        throw new \RuntimeException('Could not encode development credentials.');
    }

    $handle = @fopen($path, 'xb');
    if ($handle === false) {
        // Another bootstrap may have won the race. Re-read rather than truncate.
        if (is_file($path)) {
            return bootstrapDevelopmentCredentials($path);
        }
        throw new \RuntimeException("Could not create development credentials: {$path}");
    }
    try {
        $written = fwrite($handle, $encoded . "\n");
        if ($written !== strlen($encoded) + 1 || !fflush($handle)) {
            throw new \RuntimeException("Could not persist development credentials: {$path}");
        }
    } finally {
        fclose($handle);
    }
    if (!chmod($path, 0600)) {
        @unlink($path);
        throw new \RuntimeException("Could not enforce 0600 on development credentials: {$path}");
    }

    return $credentials;
}

/**
 * Development-only, deterministic operational fixtures.
 *
 * @return list<array{key: string, label: string, duration: int, bufferBefore: int, bufferAfter: int}>
 */
function bootstrapDevelopmentServices(): array
{
    return [
        ['key' => 'brows', 'label' => 'Sourcils', 'duration' => 90, 'bufferBefore' => 15, 'bufferAfter' => 15],
        ['key' => 'eyeliner', 'label' => 'Eyeliner', 'duration' => 120, 'bufferBefore' => 15, 'bufferAfter' => 15],
        ['key' => 'lips', 'label' => 'Lèvres', 'duration' => 120, 'bufferBefore' => 15, 'bufferAfter' => 15],
        [
            'key' => 'freckles',
            'label' => 'Taches de rousseur',
            'duration' => 60,
            'bufferBefore' => 15,
            'bufferAfter' => 15,
        ],
    ];
}

function bootstrapDevelopmentUsage(): void
{
    fwrite(
        STDOUT,
        "Usage: php bin/bootstrap-development.php --config=PATH --credentials-file=PATH\n",
    );
}

/** @var list<string> $argv */
exit(bootstrapDevelopmentMain($argv));
