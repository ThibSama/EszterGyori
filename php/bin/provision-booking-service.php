#!/usr/bin/env php
<?php

/**
 * Explicit, repeat-safe bookable-service provisioning (ESZ-041 / AUD-14).
 *
 * No migration and no application boot creates booking configuration. An
 * operator supplies the stable SiteContent key and every operational value:
 *
 * php bin/provision-booking-service.php --config=config/config.php --key=brows \
 *   --duration=120 --buffer-before=15 --buffer-after=15
 *
 * The stored booking label is NOT operator input (there is no `--label`): it
 * is the title of the matching item in the validated *published* SiteContent
 * document — the item whose `id` is `--key` — so the CMS stays the single
 * label authority and re-provisioning after a published title change
 * refreshes the stored copy. The command refuses before touching
 * `booking_services` when the key is not canonical, when no published
 * SiteContent exists yet, when the published document does not validate, or
 * when it holds no unique item for the key.
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingSerializationLock;
use Eszter\Booking\BookingServiceLabelResolver;
use Eszter\Booking\BookingValidationException;
use Eszter\Config\Configuration;
use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Storage\ContentStorage;
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

    foreach (array_keys($options) as $name) {
        if (!\in_array($name, bookingServiceOptionNames(), true)) {
            // AUD-14: `--label` is refused, not ignored — an operator who
            // still passes it must learn that the published title is now the
            // only authority, or a stale provisioning habit would silently
            // diverge from the CMS again.
            fwrite(STDERR, "provision-booking-service: unknown option --{$name}.\n");

            return 2;
        }
    }

    foreach (bookingServiceOptionNames() as $name) {
        if ($name === 'help' || $name === 'disable') {
            continue;
        }
        if (!isset($options[$name])) {
            fwrite(STDERR, "provision-booking-service: --{$name}=VALUE is required.\n");

            return 2;
        }
        if ($options[$name] === '') {
            fwrite(STDERR, "provision-booking-service: --{$name}=VALUE must not be empty.\n");

            return 2;
        }
    }

    $configPath = $options['config'];
    $key = $options['key'];

    if (!\is_string($configPath) || !\is_string($key)) {
        fwrite(STDERR, "provision-booking-service: option values must be strings.\n");

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $artifacts = new ContractArtifacts($config->contractsDir);
        $artifacts->verifyAll();
        $clock = new SystemClock();
        $validator = ContentValidator::create($artifacts);
        $storage = new ContentStorage(
            $config->contentDir,
            $config->tmpDir,
            $config->lockDir,
            $artifacts,
            $validator,
            $clock,
        );

        // The published document is the label authority (AUD-14). Its absence
        // is a refusal, not an invitation to seed defaults: provisioning must
        // never copy a title the operator did not publish.
        if (!is_file($storage->publishedPath())) {
            throw new \RuntimeException('No published SiteContent exists yet at ' . $storage->publishedPath()
                . '. Publish content (or let the first site request initialize the store) before provisioning.');
        }

        $published = $storage->readPublished();
        $contract = BookingDomainContract::fromArtifacts($artifacts);
        $label = (new BookingServiceLabelResolver($contract))->resolve($key, $published);

        $database = new Database($config->requireDatabase(), $config->lockDir);
        $repository = new BookableServiceRepository(
            $database,
            $clock,
            $contract,
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
            "%s %s (%d min, %d/%d min buffers, %s); booking label: %s.\n",
            $result['created'] ? 'Created' : 'Updated',
            $result['service']->key,
            $result['service']->durationMinutes,
            $result['service']->bufferBeforeMinutes,
            $result['service']->bufferAfterMinutes,
            $result['service']->isActive ? 'active' : 'inactive',
            $result['service']->label,
        ));

        return 0;
    } catch (BookingValidationException $exception) {
        fwrite(STDERR, 'provision-booking-service: ' . $exception->getMessage() . "\n");

        return 2;
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

/** @return list<string> */
function bookingServiceOptionNames(): array
{
    return ['config', 'key', 'duration', 'buffer-before', 'buffer-after', 'disable', 'help'];
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
    fwrite(STDOUT, "  --duration=MIN --buffer-before=MIN --buffer-after=MIN [--disable]\n");
    fwrite(STDOUT, "The stored booking label is the published SiteContent title for KEY; --label is not accepted.\n");
}

/** @var list<string> $argv */
exit(bookingServiceMain($argv));
