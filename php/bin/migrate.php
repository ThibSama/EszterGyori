<?php

/**
 * Applies pending SQL migrations (ESZ-023).
 *
 *   php bin/migrate.php --config=config/config.php
 *   php bin/migrate.php --config=config/config.php --status
 *
 * Forward-only and repeat-safe: running it against a current database applies
 * nothing and exits 0, which is what makes it safe to put in a deploy script that
 * may run twice. It never drops anything and there is deliberately no `--down`;
 * rollback is redeploying the previous artifact against a schema that is still
 * backward-compatible (`docs/hetzner-target-architecture.md` §12).
 *
 * Exit codes: 0 success, 1 migration failure, 2 usage error.
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Config\Configuration;
use Eszter\Database\Database;
use Eszter\Database\DatabaseException;
use Eszter\Database\Migrator;
use Eszter\Support\SystemClock;

require_once __DIR__ . '/../vendor/autoload.php';

/** @param list<string> $argv */
function main(array $argv): int
{
    $options = parseOptions($argv);

    if (isset($options['help'])) {
        usage();

        return 0;
    }

    $configPath = $options['config'] ?? null;

    if (!\is_string($configPath) || $configPath === '') {
        fwrite(STDERR, "migrate: --config=PATH is required.\n");
        usage();

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $database = new Database($config->requireDatabase(), $config->lockDir);
        $migrator = new Migrator($database, \dirname(__DIR__) . '/migrations', new SystemClock());

        // Reported before anything is applied, and again as the outcome, so the
        // operator sees what *was* true as well as what is.
        fwrite(STDOUT, \sprintf("database: %s\n", $config->requireDatabase()->describe()));

        if (isset($options['status'])) {
            report('applied', $migrator->appliedVersions());
            report('pending', $migrator->pendingVersions());

            return 0;
        }

        $applied = $migrator->migrate();

        if ($applied === []) {
            fwrite(STDOUT, "Already up to date; nothing was applied.\n");

            return 0;
        }

        report('applied now', $applied);

        return 0;
    } catch (DatabaseException $exception) {
        // logContext() is already scrubbed of credentials by DatabaseException.
        fwrite(STDERR, \sprintf(
            "migrate: %s\n%s\n",
            $exception->getMessage(),
            json_encode($exception->logContext(), JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT),
        ));

        return 1;
    } catch (\Throwable $exception) {
        fwrite(STDERR, 'migrate: ' . $exception->getMessage() . "\n");

        return 1;
    }
}

/** @param list<string> $versions */
function report(string $label, array $versions): void
{
    fwrite(STDOUT, \sprintf(
        "%s: %s\n",
        $label,
        $versions === [] ? '(none)' : implode(', ', $versions),
    ));
}

/**
 * @param list<string> $argv
 * @return array<string, string|true>
 */
function parseOptions(array $argv): array
{
    $options = [];

    foreach (\array_slice($argv, 1) as $argument) {
        if (!str_starts_with($argument, '--')) {
            continue;
        }

        $body = substr($argument, 2);
        $equals = strpos($body, '=');

        if ($equals === false) {
            $options[$body] = true;
            continue;
        }

        $options[substr($body, 0, $equals)] = substr($body, $equals + 1);
    }

    return $options;
}

function usage(): void
{
    fwrite(STDOUT, <<<TEXT

        Usage: php bin/migrate.php --config=PATH [--status]

          --config=PATH  The application configuration file.
          --status       List applied and pending migrations without applying any.

        Migrations are forward-only. To change the schema, add a new file to
        migrations/ named NNNN_name.sql; editing one that has already been applied
        is refused.

        TEXT);
}

/** @var list<string> $argv */
exit(main($argv));
