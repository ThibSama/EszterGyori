<?php

declare(strict_types=1);

namespace Eszter\Auth;

use Eszter\Admin\AccountDirectory;
use Eszter\Admin\AdminAccount;
use Eszter\Admin\AdminAccountRepository;
use Eszter\Admin\AdminEmail;
use Eszter\Database\Database;
use Eszter\Http\HttpException;
use Eszter\Support\Clock;
use Eszter\Support\Logger;

/**
 * Sign in, sign out, and who-is-this (ESZ-025).
 *
 * Everything privileged is decided here, per request, server-side.
 * `docs/hetzner-target-architecture.md` §6 is blunt about why: the Next.js
 * middleware that used to gate `/admin` is gone and was not replaced in kind,
 * because `/admin` is now a static file that enforces nothing. "PHP-side
 * enforcement is not a defence-in-depth nicety — it is the only thing standing
 * there."
 */
final class Authenticator
{
    /**
     * A password verification is performed even when no account matched, against
     * this hash. Without it, an unknown address returns in the time of one index
     * lookup and a known one in the time of an Argon2 verification — a difference
     * of milliseconds that is trivially measurable and turns the login endpoint
     * into an account enumeration oracle, which `auth.loginFailure` forbids.
     *
     * Computed lazily and once per request rather than hard-coded, so it always
     * uses the same algorithm and cost parameters as the real hashes it is
     * standing in for; a hard-coded bcrypt string would stop matching the moment
     * PASSWORD_DEFAULT moved to Argon2id and the timing gap would silently reopen.
     */
    private ?string $decoyHash = null;

    public function __construct(
        private readonly AccountDirectory $accounts,
        private readonly SessionManager $sessions,
        private readonly Clock $clock,
        private readonly Logger $logger,
        /**
         * The shared database the account directory and the session store write
         * through, when both are the SQL implementations. Null in the
         * seam-driven replay wiring, where there is no SQL to transact; there,
         * and there only, the rotation is compensated rather than rolled back.
         *
         * {@see \Eszter\Kernel::boot()} decides which wiring is in front of it
         * and passes the database exactly when it built the SQL implementations
         * itself.
         */
        private readonly ?Database $database = null,
    ) {
    }

    /**
     * The account this request is acting as, or null.
     *
     * Re-read from the directory on every call rather than trusted from the
     * session, so that disabling an account takes effect on its *next request*
     * instead of at its next login. A session that names a deleted or disabled
     * account is detached, not destroyed: the row stays, and stops authorising
     * anything.
     */
    public function currentAccount(): ?AdminAccount
    {
        $session = $this->sessions->current();

        if ($session === null || !$session->isAuthenticated()) {
            return null;
        }

        /** @var int $accountId */
        $accountId = $session->accountId;
        $account = $this->accounts->findById($accountId);

        if ($account === null || !$account->isEnabled) {
            $this->logger->warn('Session detached from an account that can no longer sign in.', [
                'accountId' => $accountId,
                'reason' => $account === null ? 'missing' : 'disabled',
            ]);
            $this->sessions->detachAccount();

            return null;
        }

        return $account;
    }

    /** @throws HttpException 401 UNAUTHENTICATED */
    public function requireAccount(): AdminAccount
    {
        $account = $this->currentAccount();

        if ($account === null) {
            throw HttpException::unauthenticated();
        }

        return $account;
    }

    /**
     * Verifies a credential pair and, on success, rotates the session onto it.
     *
     * The three failure paths — no such address, wrong password, disabled account
     * — converge on one `throw` with no argument, and all three reach it having
     * done one password verification. The reason is written to the log, where it
     * belongs; it is not expressible in the response.
     *
     * A verified credential then commits one atomic transition — session
     * rotation, the login record and any required hash upgrade — and only a
     * committed transition publishes the authenticated session/cookie. A failure
     * inside the transition (ESZ-134) rolls it back and reconciles the
     * request-local session state, so the error response that follows never
     * carries an authenticated cookie and no authenticated row survives.
     *
     * @throws HttpException 401 INVALID_CREDENTIALS
     */
    public function login(string $email, string $password): AdminAccount
    {
        // Normalised, never validated: a malformed address is simply an address
        // with no account. Answering 400 to it would separate "not an address"
        // from "not registered", and those must look the same.
        $normalized = AdminEmail::normalize($email);
        $account = $this->accounts->findByEmail($normalized);

        $hash = $account === null ? $this->decoyHash() : $account->passwordHash;
        $passwordMatches = password_verify($password, $hash);

        // Deliberately not short-circuited into the checks above: the verification
        // has already happened for every path by the time this is evaluated.
        if ($account === null || !$passwordMatches || !$account->isEnabled) {
            $this->logger->warn('Login rejected.', [
                'reason' => match (true) {
                    $account === null => 'unknown-account',
                    !$passwordMatches => 'wrong-password',
                    default => 'account-disabled',
                },
                // The address is logged because an operator investigating a
                // lockout needs it. The password is not, anywhere, ever.
                'email' => $normalized,
            ]);

            throw HttpException::invalidCredentials();
        }

        // From here the login is one transition — rotation, login record and
        // (when the stored hash is outdated) its rehash — and it is all or
        // nothing. Where the SQL implementations share one Database, the
        // transition runs inside Database::transactional(), so a failure after
        // the rotation rolls the authenticated session row, last_login_at and
        // the hash change back together; only after that commit is the
        // authenticated session/cookie published by the response. In the
        // seam-driven replay wiring (no SQL) the same transition runs directly
        // and a failure is compensated by SessionManager::revokeRotation()
        // instead of by a rollback. Either way the request-local session state
        // is reconciled on failure, so an error response never carries the
        // rotated cookie and the rotated id never authorises a later request.
        $now = $this->clock->nowIso();

        $transition = function () use ($account, $password, $now): void {
            $this->sessions->rotate($account->id);
            $this->accounts->recordLogin($account->id, $now);

            // An algorithm or cost change only ever reaches an existing account
            // here: it is the one moment the plaintext is available to re-hash
            // with.
            if (
                $this->accounts instanceof AdminAccountRepository
                && AdminAccountRepository::needsRehash($account->passwordHash)
            ) {
                $this->accounts->upgradeHash($account->id, $password);
                $this->logger->info('Password hash upgraded to the current algorithm.', [
                    'accountId' => $account->id,
                ]);
            }
        };

        try {
            if ($this->database === null) {
                $transition();
            } else {
                $this->database->transactional($transition);
            }
        } catch (\Throwable $failure) {
            try {
                $this->sessions->revokeRotation();
            } catch (\Throwable $revocationFailure) {
                // The original failure is the one to report; revocation already
                // reconciled the request-local state before it could throw, so
                // nothing authenticated is published regardless. Log the
                // compensation failure — its message and context carry no
                // session id and no credential.
                $this->logger->error(
                    'Login failed and its session rotation could not be fully revoked.',
                    [
                        'accountId' => $account->id,
                        'detail' => $revocationFailure->getMessage(),
                    ],
                );
            }

            throw $failure;
        }

        $this->logger->info('Login accepted.', ['accountId' => $account->id]);

        return new AdminAccount(
            $account->id,
            $account->email,
            $account->passwordHash,
            $account->isEnabled,
            $account->createdAt,
            $account->updatedAt,
            $now,
        );
    }

    /** @throws HttpException 401 when there is no session to end. */
    public function logout(): void
    {
        $account = $this->requireAccount();
        $this->sessions->destroy();
        $this->logger->info('Logout completed; the session record was deleted.', [
            'accountId' => $account->id,
        ]);
    }

    private function decoyHash(): string
    {
        return $this->decoyHash ??= AdminAccountRepository::hash(bin2hex(random_bytes(16)));
    }

    /**
     * The body shared by `GET /api/auth/session` and a successful login.
     *
     * Built from `authSessionResponseSchema`, which is strict: adding a field here
     * that the schema does not declare fails `php:http-contract` rather than
     * quietly shipping. That is what keeps a session id or a hash from ever
     * reaching this shape by accident.
     *
     * @return array{
     *     authenticated: bool,
     *     account: array{email: string, lastLoginAt: string|null}|null,
     *     csrfToken: string,
     * }
     */
    public function sessionResponse(?AdminAccount $account): array
    {
        // Guarantees a session — and therefore a CSRF token — exists even for an
        // anonymous caller. That is what lets POST /api/auth/login be CSRF-checked
        // at all: the caller reads a token here first.
        $session = $this->sessions->ensure();

        return [
            'authenticated' => $account !== null,
            'account' => $account?->publicView(),
            'csrfToken' => $session->csrfToken,
        ];
    }
}
