<?php

/**
 * Writes one backup archive (ESZ-083).
 *
 *   php bin/backup.php --config=config/config.php --to=../backups
 *
 * Read-only with respect to durable application state: it opens the database,
 * reads content and media, and writes one archive into the destination. Its only
 * deployment-side write is the excluded advisory snapshot lock; no data is
 * created, seeded or repaired.
 *
 * What it carries and what it deliberately leaves out is declared in
 * `Eszter\Backup\BackupSet` and repeated in `docs/backup-and-restore.md`. The
 * short version: data, not secrets and not code. Logs are outside the declared
 * set, an unsafe overlap with a walked media directory is refused, and neither
 * locks, temporary files nor the application itself enter the archive.
 *
 * The archive contains customer names, e-mail addresses and phone numbers. It is
 * written 0600, it is refused if the destination is inside the document root, and
 * it should be treated as the personal-data store it is.
 *
 * Exit codes: 0 success, 1 failure, 2 usage error.
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Backup\BackupException;
use Eszter\Backup\BackupWriter;
use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Database\DatabaseException;
use Eszter\Database\Migrator;
use Eszter\Support\CommandOptions;
use Eszter\Support\SystemClock;

require_once __DIR__ . '/../vendor/autoload.php';

/** @param list<string> $argv */
function main(array $argv): int
{
    $options = CommandOptions::parse($argv);

    if ($options->flag('help')) {
        usage();

        return 0;
    }

    $configPath = $options->value('config');
    $destination = $options->value('to');

    if ($configPath === null) {
        fwrite(STDERR, "backup: --config=PATH is required.\n");
        usage();

        return 2;
    }

    if ($destination === null) {
        fwrite(STDERR, "backup: --to=DIRECTORY is required.\n");
        usage();

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $clock = new SystemClock();
        $database = new Database($config->requireDatabase(), $config->lockDir);
        $artifacts = new ContractArtifacts($config->contractsDir);

        // Verified before anything is read. A backup taken through unverified
        // contract artifacts would record a content schema version it has no
        // grounds to claim.
        $artifacts->verifyAll();

        $writer = new BackupWriter(
            $config,
            $database,
            $artifacts,
            new Migrator($database, \dirname(__DIR__) . '/migrations', $clock),
            $clock,
        );

        $result = $writer->write($destination);
        $manifest = $result['manifest'];

        fwrite(STDOUT, \sprintf("archive: %s\n", $result['path']));
        fwrite(STDOUT, \sprintf("bytes:   %d\n", $result['bytes']));
        fwrite(STDOUT, \sprintf("files:   %d\n", \count($manifest->entries)));
        fwrite(STDOUT, \sprintf("digest:  %s\n", $manifest->entriesDigest));
        fwrite(STDOUT, \sprintf("schema:  %s\n", implode(', ', $manifest->appliedMigrations)));

        foreach ($manifest->rowCounts as $table => $count) {
            fwrite(STDOUT, \sprintf("  %-32s %d row(s)\n", $table, $count));
        }

        foreach ($manifest->excludedTables as $table => $reason) {
            fwrite(STDOUT, \sprintf("  %-32s excluded — %s\n", $table, $reason));
        }

        return 0;
    } catch (BackupException | DatabaseException $exception) {
        fwrite(STDERR, 'backup: ' . $exception->getMessage() . "\n");

        return 1;
    } catch (\Throwable $exception) {
        fwrite(STDERR, 'backup: ' . $exception->getMessage() . "\n");

        return 1;
    }
}

function usage(): void
{
    fwrite(STDOUT, <<<TEXT

        Usage: php bin/backup.php --config=PATH --to=DIRECTORY

          --config=PATH    The application configuration file.
          --to=DIRECTORY   Where the archive is written. Must exist, must be
                           writable, and must NOT be inside the document root:
                           the archive carries customer data and everything
                           under the document root is served.

        The archive is `eszter-backup-<YYYYMMDD-HHMMSS>.tar.gz`, mode 0600. It
        holds the database rows, the content JSON, and the media originals and
        derivatives, with a manifest carrying a sha256 for every entry.

        It never holds configuration, secrets, logs, locks, temporary files,
        in-flight uploads, sessions, rate-limit counters or application code.
        A log directory beneath a walked media directory is refused before export.

        Verify and apply one with bin/restore.php.

        TEXT);
}

/** @var list<string> $argv */
exit(main($argv));
