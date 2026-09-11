#!/usr/bin/env php
<?php

/**
 * Explicit, repeat-safe bookable-service provisioning (ESZ-041 / ESZ-149).
 *
 * No migration and no application boot creates booking configuration. An
 * operator supplies the stable key and every operational value:
 *
 * php bin/provision-booking-service.php --config=config/config.php --key=brows \
 *   --duration=120 --buffer-before=15 --buffer-after=15 [--label=NAME] [--disable]
 *
 * Since ESZ-149 the catalog row is the authority for a service's name,
 * description and image, and the administrator edits them in the back-office
 * (`/admin/services`). This command therefore never rewrites editorial facts
 * over an existing row: re-provisioning refreshes duration, buffers and
 * activity only, and `--label` against an existing key is refused rather
 * than silently claiming a rename. When the command *creates* a row it needs
 * a name from somewhere — `--label` when given, otherwise the title of the
 * matching item of the validated *published* SiteContent document, whose
 * description and managed visual seed the new row's description and image in
 * the same pass. A new key with neither is refused before any row appears;
 * nothing is ever invented.
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
use Eszter\Contract\StructuralValidator;
use Eszter\Database\Database;
use Eszter\Media\ManagedServiceImageReferencePolicy;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaLibrary;
use Eszter\Storage\ContentStorage;
use Eszter\Storage\MediaContentLock;
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
            fwrite(STDERR, "provision-booking-service: unknown option --{$name}.\n");

            return 2;
        }
    }

    foreach (bookingServiceOptionNames() as $name) {
        if ($name === 'help' || $name === 'disable' || $name === 'label') {
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
    $operatorLabel = $options['label'] ?? null;

    if (!\is_string($configPath) || !\is_string($key) || ($operatorLabel !== null && !\is_string($operatorLabel))) {
        fwrite(STDERR, "provision-booking-service: option values must be strings.\n");

        return 2;
    }
    if ($operatorLabel !== null && trim($operatorLabel) === '') {
        fwrite(STDERR, "provision-booking-service: --label=VALUE must not be empty.\n");

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

        $contract = BookingDomainContract::fromArtifacts($artifacts);
        if (!$contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Malformed service key.');
        }

        $media = MediaContract::fromArtifacts($artifacts);
        $library = new MediaLibrary(
            $media,
            $config->contentDir,
            $config->mediaOriginalsDir,
            $config->mediaPublicDir(),
            $config->tmpDir,
            $config->lockDir,
            $artifacts,
            new StructuralValidator($artifacts),
            $clock,
        );
        $database = new Database($config->requireDatabase(), $config->lockDir);
        $repository = new BookableServiceRepository(
            $database,
            $clock,
            $contract,
            new BookingSerializationLock($database),
            new ManagedServiceImageReferencePolicy($media, $library, new MediaContentLock($config->lockDir)),
        );

        $existing = $repository->find($key);
        $description = null;
        $imageSrc = null;

        if ($existing !== null) {
            // ESZ-149: the row is the authority for its editorial facts.
            // Re-provisioning never renames; the back-office does.
            if ($operatorLabel !== null) {
                fwrite(STDERR, \sprintf(
                    "provision-booking-service: %s already exists; --label cannot rename an existing service."
                    . " Its name, description and image are edited in the back-office (/admin/services).\n",
                    $key,
                ));

                return 2;
            }
            $label = $existing->label;
        } elseif ($operatorLabel !== null) {
            $label = $operatorLabel;
        } else {
            // A new row with no operator name: the published SiteContent item
            // of the same key is the only deterministic seed. Its absence is a
            // refusal, not an invitation to invent a name.
            if (!is_file($storage->publishedPath())) {
                throw new \RuntimeException('No published SiteContent exists yet at ' . $storage->publishedPath()
                    . '. Publish content (or let the first site request initialize the store), or pass --label,'
                    . ' before provisioning.');
            }
            $seed = (new BookingServiceLabelResolver($contract))->seed($key, $storage->readPublished());
            if ($seed === null) {
                throw new \RuntimeException(\sprintf(
                    'The published SiteContent holds no services item with id "%s"; pass --label to name'
                    . ' the new service.',
                    $key,
                ));
            }
            $label = $seed['label'];
            $description = $seed['description'];
            // Only a managed media path can be stored as the image; the
            // canonical defaults carry null visuals and an external URL is
            // the home page's business, not the catalog's.
            $imageSrc = $seed['imageSrc'] !== null && $media->isManagedPublicPath($seed['imageSrc'])
                ? $seed['imageSrc']
                : null;
        }

        $result = $repository->provision(
            $key,
            $label,
            bookingServiceInteger($options, 'duration'),
            bookingServiceInteger($options, 'buffer-before'),
            bookingServiceInteger($options, 'buffer-after'),
            !isset($options['disable']),
            $description,
            $imageSrc,
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
    return ['config', 'key', 'label', 'duration', 'buffer-before', 'buffer-after', 'disable', 'help'];
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
    fwrite(STDOUT, "  --duration=MIN --buffer-before=MIN --buffer-after=MIN [--label=NAME] [--disable]\n");
    fwrite(STDOUT, "A new row is named by --label, or by the published SiteContent item for KEY (whose description\n");
    fwrite(STDOUT, "and image seed it). An existing row keeps its admin-owned name, description and image;\n");
    fwrite(STDOUT, "--label with an existing KEY is refused — rename in the back-office (/admin/services).\n");
}

/** @var list<string> $argv */
exit(bookingServiceMain($argv));
