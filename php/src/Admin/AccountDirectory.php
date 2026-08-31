<?php

declare(strict_types=1);

namespace Eszter\Admin;

/**
 * Where the authenticator looks accounts up.
 *
 * An interface for the same reason `PublishedContentReader` is one: the HTTP
 * conformance suite replays `http-contract.json` against the real front
 * controller, and it must be able to do that without a MySQL instance. The
 * SQL-backed implementation is proved separately by the `sql:integration` gate
 * against a real server, so neither half is taken on trust.
 *
 * It is deliberately narrow. Everything that *writes* an account lives in
 * {@see AdminAccountRepository} and is reachable only from the provisioning CLI,
 * so no request path can create or modify an account at all.
 */
interface AccountDirectory
{
    /** @param string $normalizedEmail Already through {@see AdminEmail::normalize()}. */
    public function findByEmail(string $normalizedEmail): ?AdminAccount;

    public function findById(int $id): ?AdminAccount;

    /** Records a successful sign-in. Never called on a failed one. */
    public function recordLogin(int $id, string $at): void;
}
