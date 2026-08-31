<?php

/**
 * Creates or updates one admin account (ESZ-024).
 *
 *   php bin/provision-admin.php --config=config/config.php --email=her@example.com
 *   php bin/provision-admin.php --config=config/config.php --email=… --disable
 *   php bin/provision-admin.php --config=config/config.php --list
 *
 * ## No account is ever created implicitly
 *
 * Not by a migration, not at boot, not on a first request. A default account —
 * `admin` / anything — would exist identically on every deployment of this
 * application, and would be found by the first scanner that looked. Provisioning
 * is an explicit act by an operator who supplies both halves of the credential,
 * and this script is the only code in the repository that can write to
 * `admin_accounts` at all.
 *
 * ## The password never appears in an argument
 *
 * It is read from the terminal with echo suppressed, or from stdin when the input
 * is piped. `--password=…` is deliberately not accepted: process arguments are
 * visible to every user on the host through `ps`, and they are recorded verbatim
 * in the operator's shell history.
 *
 * ## Repeat-safe
 *
 * Running it twice with the same address updates the same row instead of failing
 * on the unique index or creating a second account. The realistic way it gets run
 * is twice — once, and then again by someone who is not sure the first one worked.
 *
 * Exit codes: 0 success, 1 failure, 2 usage error.
 */

declare(strict_types=1);

namespace Eszter\Bin;

use Eszter\Admin\AdminAccountRepository;
use Eszter\Admin\AdminEmail;
use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
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

    if (isset($options['password'])) {
        fwrite(
            STDERR,
            "provision-admin: --password is not accepted. Process arguments are visible\n"
            . "to every user on this host via `ps` and are written to your shell history.\n"
            . "Run without it to be prompted, or pipe the password on stdin.\n",
        );

        return 2;
    }

    $configPath = $options['config'] ?? null;

    if (!\is_string($configPath) || $configPath === '') {
        fwrite(STDERR, "provision-admin: --config=PATH is required.\n");
        usage();

        return 2;
    }

    try {
        $config = Configuration::fromFile($configPath);
        $clock = new SystemClock();
        $database = new Database($config->requireDatabase());
        $repository = new AdminAccountRepository($database, $clock);
        $artifacts = new ContractArtifacts($config->contractsDir);
        $artifacts->verifyAll();

        if (isset($options['list'])) {
            return listAccounts($repository);
        }

        $rawEmail = $options['email'] ?? null;

        if (!\is_string($rawEmail) || $rawEmail === '') {
            fwrite(STDERR, "provision-admin: --email=ADDRESS is required.\n");

            return 2;
        }

        $email = AdminEmail::fromString($rawEmail, $artifacts);

        if (isset($options['disable']) && isset($options['enable'])) {
            fwrite(STDERR, "provision-admin: --enable and --disable are mutually exclusive.\n");

            return 2;
        }

        $enabled = !isset($options['disable']);
        $existing = $repository->findByEmail($email->value);

        // An existing account keeps its password unless one is supplied, so
        // `--disable` alone is a pure state change and does not require the
        // operator to know the password in order to lock the account out.
        $password = null;

        if ($existing === null || isset($options['set-password'])) {
            $password = readPassword($existing === null, $artifacts);

            if ($password === null) {
                return 1;
            }
        }

        $result = $repository->provision($email, $password, $enabled);

        fwrite(STDOUT, \sprintf(
            "%s %s (%s)%s\n",
            $result['created'] ? 'Created' : 'Updated',
            $result['account']->email,
            $result['account']->isEnabled ? 'enabled' : 'disabled',
            $result['passwordChanged'] ? ', password set' : '',
        ));

        if (!$result['account']->isEnabled) {
            // Disabling has to reach the sessions that already exist, otherwise it
            // only prevents the *next* login and the account stays signed in.
            $destroyed = (new \Eszter\Auth\PdoSessionStore($database, $clock))
                ->destroyForAccount($result['account']->id);

            fwrite(STDOUT, \sprintf("Signed out of %d existing session(s).\n", $destroyed));
        }

        return 0;
    } catch (\InvalidArgumentException $exception) {
        fwrite(STDERR, 'provision-admin: ' . $exception->getMessage() . "\n");

        return 2;
    } catch (\Throwable $exception) {
        fwrite(STDERR, 'provision-admin: ' . $exception->getMessage() . "\n");

        return 1;
    }
}

function listAccounts(AdminAccountRepository $repository): int
{
    $accounts = $repository->all();

    if ($accounts === []) {
        fwrite(STDOUT, "No admin accounts exist. Nothing can sign in.\n");

        return 0;
    }

    foreach ($accounts as $account) {
        fwrite(STDOUT, \sprintf(
            "%-40s %-9s last login: %s\n",
            $account->email,
            $account->isEnabled ? 'enabled' : 'disabled',
            $account->lastLoginAt ?? 'never',
        ));
    }

    return 0;
}

/**
 * Reads a password from the terminal without echoing it, or from a pipe.
 *
 * The confirmation prompt is skipped for a piped password: there is nobody there
 * to mistype it twice differently, and demanding the value twice on stdin would
 * only make the script awkward to automate.
 */
function readPassword(bool $isNewAccount, ContractArtifacts $artifacts): ?string
{
    $minimum = passwordMinimum($artifacts);
    $isTty = stream_isatty(STDIN);

    if (!$isTty) {
        $password = rtrim((string) fgets(STDIN), "\r\n");
    } else {
        fwrite(STDOUT, $isNewAccount ? "New account.\n" : "Setting a new password.\n");
        $password = prompt('Password: ');
        $confirmation = prompt('Confirm password: ');

        if ($password !== $confirmation) {
            fwrite(STDERR, "provision-admin: the two passwords do not match.\n");

            return null;
        }
    }

    if (mb_strlen($password, 'UTF-8') < $minimum) {
        fwrite(STDERR, \sprintf(
            "provision-admin: the password must be at least %d characters.\n",
            $minimum,
        ));

        return null;
    }

    return $password;
}

function prompt(string $label): string
{
    fwrite(STDOUT, $label);

    // `stty -echo` is the portable-enough way to suppress echo on the hosts this
    // ships to. If it is unavailable the password would be echoed, so the failure
    // is reported rather than silently accepted.
    $previous = @shell_exec('stty -g 2>/dev/null');

    if (!\is_string($previous) || trim($previous) === '') {
        fwrite(STDOUT, "\n[warning] echo could not be suppressed; the password will be visible.\n");
        $value = rtrim((string) fgets(STDIN), "\r\n");

        return $value;
    }

    @shell_exec('stty -echo');
    $value = rtrim((string) fgets(STDIN), "\r\n");
    @shell_exec('stty ' . escapeshellarg(trim($previous)));
    fwrite(STDOUT, "\n");

    return $value;
}

function passwordMinimum(ContractArtifacts $artifacts): int
{
    /** @var mixed $identity */
    $identity = $artifacts->authContract()['identity'] ?? null;
    /** @var mixed $minimum */
    $minimum = \is_array($identity) ? ($identity['passwordMinLength'] ?? null) : null;

    if (!\is_int($minimum)) {
        throw new \RuntimeException('http-contract.json has no auth.identity.passwordMinLength.');
    }

    return $minimum;
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

        Usage: php bin/provision-admin.php --config=PATH [options]

          --config=PATH     The application configuration file. Required.
          --email=ADDRESS   The account to create or update.
          --set-password    Prompt for a new password on an existing account.
          --enable          Enable the account (the default for a new one).
          --disable         Disable it, and sign out every session it has.
          --list            List existing accounts and exit.

        The password is read from the terminal with echo off, or from stdin when
        piped. It is never taken from an argument.

        TEXT);
}

/** @var list<string> $argv */
exit(main($argv));
