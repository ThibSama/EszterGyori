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
 * Interactive prompting is fail-closed: if the terminal state cannot be captured
 * or echo cannot be suppressed, the script aborts before reading anything rather
 * than showing the password, and the captured state is restored on every path
 * after it may have changed.
 *
 * ## Repeat-safe
 *
 * Running it twice with the same address updates the same row instead of failing
 * on the unique index or creating a second account. The realistic way it gets run
 * is twice — once, and then again by someone who is not sure the first one worked.
 *
 * ## A password change on an existing account is a credential rotation (ESZ-101)
 *
 * `--set-password` replaces the secret an existing account's sessions were
 * authenticated against, so it revokes every one of those sessions — in the same
 * MySQL transaction as the hash update. If the revocation fails, the new hash is
 * rolled back with it and the command fails, leaving the account able to sign in
 * with the old password and its old sessions intact; if the account update
 * fails, nothing has been revoked. A new account has no sessions to revoke, and
 * `--disable` still reaches existing sessions after the provisioning transaction
 * as before. The automatic login-time `password_needs_rehash()` upgrade is
 * maintenance, not a rotation, and never revokes anything.
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
use Eszter\Support\PasswordPrompt;
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
        $database = new Database($config->requireDatabase(), $config->lockDir);
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

        $sessionStore = new \Eszter\Auth\PdoSessionStore($database, $clock);
        $result = provisionAtomically($database, $repository, $sessionStore, $email, $password, $enabled);

        fwrite(STDOUT, \sprintf(
            "%s %s (%s)%s\n",
            $result['created'] ? 'Created' : 'Updated',
            $result['account']->email,
            $result['account']->isEnabled ? 'enabled' : 'disabled',
            $result['passwordChanged'] ? ', password set' : '',
        ));

        if ($result['passwordChanged'] && !$result['created']) {
            // The revocation ran inside the provisioning transaction above; this
            // line is the operator-facing record of it. Counts only — no session
            // id, hash or password ever reaches the output.
            fwrite(STDOUT, \sprintf("Signed out of %d existing session(s).\n", $result['sessionsRevoked']));
        }

        if (!$result['account']->isEnabled) {
            // Disabling has to reach the sessions that already exist, otherwise it
            // only prevents the *next* login and the account stays signed in. This
            // stays after the provisioning transaction on purpose: a disabled
            // account is refused on its next request regardless, so the failure
            // that matters is the account update failing, never this sweep.
            $destroyed = $sessionStore->destroyForAccount($result['account']->id);

            // A rotation in the same run already revoked them in-transaction, so
            // this second sweep can legitimately find none; only report a real one.
            if ($destroyed > 0) {
                fwrite(STDOUT, \sprintf("Signed out of %d existing session(s).\n", $destroyed));
            }
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

/**
 * Provisions the account and, when an existing account's password was changed,
 * revokes every session it had — all in one MySQL transaction (ESZ-101).
 *
 * A password change on an existing account is a credential rotation: every
 * session it has was authenticated against the old secret, so the hash update
 * and the revocation must commit together or not at all. {@see Database::transactional()}
 * nests, so the repository's own provisioning transaction joins this one and
 * nothing is committed until the revocation has run.
 *
 *  - The revocation fails → the whole transaction rolls back, the old hash and
 *    the old sessions survive, and the CLI reports the failure (exit 1).
 *  - The account update fails → the revocation never runs, so nothing was
 *    revoked.
 *  - A brand-new account (`created`) reports `passwordChanged` too, but it had
 *    no sessions to revoke; creation stays repeat-safe as before.
 *
 * @param string|null $plainPassword Null leaves an existing hash untouched.
 * @return array{
 *     account: \Eszter\Admin\AdminAccount,
 *     created: bool,
 *     passwordChanged: bool,
 *     sessionsRevoked: int,
 * }
 */
function provisionAtomically(
    Database $database,
    AdminAccountRepository $repository,
    \Eszter\Auth\PdoSessionStore $sessions,
    AdminEmail $email,
    ?string $plainPassword,
    bool $enabled,
): array {
    return $database->transactional(
        function () use ($repository, $sessions, $email, $plainPassword, $enabled): array {
            $result = $repository->provision($email, $plainPassword, $enabled);
            $sessionsRevoked = 0;

            if (!$result['created'] && $result['passwordChanged']) {
                $sessionsRevoked = $sessions->destroyForAccount($result['account']->id);
            }

            return $result + ['sessionsRevoked' => $sessionsRevoked];
        },
    );
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
 * Interactive prompting is fail-closed: the terminal state is captured and echo
 * suppression is proved before anything is read, and the captured state is
 * restored on every path after it may have changed. A terminal-control failure
 * aborts provisioning instead of showing the password.
 *
 * The confirmation prompt is skipped for a piped password: there is nobody there
 * to mistype it twice differently, and demanding the value twice on stdin would
 * only make the script awkward to automate.
 */
function readPassword(bool $isNewAccount, ContractArtifacts $artifacts): ?string
{
    return PasswordPrompt::forStandardStreams()->readPassword($isNewAccount, passwordMinimum($artifacts));
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
                            Signs every existing session of that account out in
                            the same transaction as the hash update.
          --enable          Enable the account (the default for a new one).
          --disable         Disable it, and sign out every session it has.
          --list            List existing accounts and exit.

        The password is read from the terminal with echo off, or from stdin when
        piped. It is never taken from an argument.

        TEXT);
}

/** @var list<string> $argv */
exit(main($argv));
