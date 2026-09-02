<?php

/**
 * Verifies and applies one backup archive (ESZ-083).
 *
 *   php bin/restore.php --config=config/config.php --from=eszter-backup-20260821-120000.tar.gz
 *
 * ## Order of operations
 *
 * Read the bounded archive; verify its manifest; fully parse the row-only SQL;
 * validate schema direction, safety refusals and content/media contracts; stage
 * every file; then replace SQL and files with rollback compensation. A populated
 * target with pending migrations is refused rather than migrated as a side effect.
 *
 * ## The two refusals
 *
 * A restore replaces content and empties tables, so pointing it at the wrong
 * deployment destroys that deployment. Two flags stand in the way, each catching a
 * different mistake:
 *
 *   --overwrite          The target already holds data. This is the accident:
 *                        the operator meant the staging config and typed the
 *                        production one.
 *   --allow-production   The configuration names a production environment. This
 *                        is the deliberate act that still deserves a second
 *                        sentence, because "restore production" and "restore
 *                        production onto the wrong host" look identical until
 *                        afterwards.
 *
 * Restoring a real site over itself needs both. Neither has a default that says
 * yes and neither has a short form.
 *
 * ## After a restore
 *
 * Every admin session is gone — sessions are deliberately not in the backup —
 * so the operator signs in again. Customer-data retention (ESZ-140) is applied
 * to the restored rows inside the replacement transaction, before this command
 * can report success: bookings whose customer data was already past the
 * retention cutoff are anonymized and their pending/processing notification
 * jobs retired, so the queue can resume only from rows that may still deliver.
 * The remaining queue should still be checked before letting a tick fire
 * against real customers.
 *
 * Exit codes: 0 success, 1 failure or refusal, 2 usage error.
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Backup\BackupException;
use Eszter\Backup\BackupRestore;
use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Database\DatabaseException;
use Eszter\Database\Migrator;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\NotificationPolicy;
use Eszter\Retention\BookingRetentionService;
use Eszter\Retention\RetentionPolicy;
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
    $archivePath = $options->value('from');

    if ($configPath === null) {
        fwrite(STDERR, "restore: --config=PATH is required.\n");
        usage();

        return 2;
    }

    if ($archivePath === null) {
        fwrite(STDERR, "restore: --from=ARCHIVE is required.\n");
        usage();

        return 2;
    }

    if (!is_file($archivePath)) {
        fwrite(STDERR, "restore: no such archive: {$archivePath}\n");

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $clock = new SystemClock();
        $database = new Database($config->requireDatabase(), $config->lockDir);

        $artifacts = new ContractArtifacts($config->contractsDir);
        $artifacts->verifyAll();

        fwrite(STDOUT, \sprintf("database: %s\n", $config->requireDatabase()->describe()));
        fwrite(STDOUT, \sprintf("archive:  %s\n", $archivePath));

        $restore = new BackupRestore(
            $config,
            $database,
            new Migrator($database, \dirname(__DIR__) . '/migrations', $clock),
            null,
            new BookingRetentionService(
                $database,
                $clock,
                RetentionPolicy::fromArtifacts($artifacts),
                new NotificationJobRepository(
                    $database,
                    $clock,
                    NotificationPolicy::fromArtifacts($artifacts),
                ),
            ),
        );

        $result = $restore->restore(
            $archivePath,
            $options->flag('overwrite'),
            $options->flag('allow-production'),
        );

        $manifest = $result['manifest'];

        fwrite(STDOUT, \sprintf("taken:    %s\n", $manifest->createdAt));
        fwrite(STDOUT, \sprintf("verified: %d file(s) against their digests\n", \count($manifest->entries)));
        fwrite(STDOUT, \sprintf(
            "migrated: %s\n",
            $result['migrations'] === [] ? 'already up to date' : implode(', ', $result['migrations']),
        ));
        fwrite(STDOUT, \sprintf("rows:     %d inserted\n", $result['statements']));
        fwrite(STDOUT, \sprintf("files:    %d written\n", $result['files']));

        // ESZ-140: the restored data has been reconciled against the retention
        // policy before this line can be reached — restored rows whose customer
        // data was already expired are anonymized here, with their pending
        // notification jobs retired. Counts only, never references or values.
        fwrite(STDOUT, \sprintf(
            "retention: %d restored booking(s) past the retention cutoff (%d erased, %d job(s) retired)\n",
            $result['retention']['reconciled'],
            $result['retention']['erased'],
            $result['retention']['retired'],
        ));

        // Said plainly rather than left to be discovered. Both are consequences of
        // what the backup deliberately does not carry, and both surprise people.
        fwrite(STDOUT, "\nAdmin sessions were not restored; sign in again.\n");
        fwrite(STDOUT, "Retention was reconciled before this restore reported success;\n");
        fwrite(STDOUT, "check remaining notification jobs before the next cron tick.\n");

        return 0;
    } catch (BackupException $exception) {
        // A refusal, not a crash: the message is the operator's next step.
        fwrite(STDERR, 'restore: ' . $exception->getMessage() . "\n");

        return 1;
    } catch (DatabaseException $exception) {
        fwrite(STDERR, \sprintf(
            "restore: %s\n%s\n",
            $exception->getMessage(),
            json_encode($exception->logContext(), JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT),
        ));

        return 1;
    } catch (\Throwable $exception) {
        fwrite(STDERR, 'restore: ' . $exception->getMessage() . "\n");

        return 1;
    }
}

function usage(): void
{
    fwrite(STDOUT, <<<TEXT

        Usage: php bin/restore.php --config=PATH --from=ARCHIVE
                                   [--overwrite] [--allow-production]

          --config=PATH        The configuration of the deployment to restore INTO.
          --from=ARCHIVE       An archive written by bin/backup.php.
          --overwrite          Required when the target already holds data.
          --allow-production   Required when the configuration names production.

        Every entry is checked against the manifest's sha256 before anything is
        written, and the schema is migrated first, so the dump's missing DDL is
        deliberate: an older backup restores onto a newer schema and picks up the
        new columns' defaults. A backup from a NEWER schema is refused.

        Admin sessions, rate-limit counters and logs are not in a backup and
        are not restored. Restored bookings past the retention cutoff are
        anonymized, with their pending jobs retired, before success is reported.

        TEXT);
}

/** @var list<string> $argv */
exit(main($argv));
