<?php

declare(strict_types=1);

namespace Eszter\Admin;

use Eszter\Contract\ContractArtifacts;

/**
 * A normalised admin login identifier (ESZ-024).
 *
 * ## Normalisation *is* identity
 *
 * `admin_accounts.email` carries a unique index. What that index means depends
 * entirely on what is written into the column, so the normalisation below is not
 * a convenience — it is the definition of "one person". If the login path and the
 * provisioning path normalised differently, `Eszter@…` and `eszter@…` would be
 * two rows, and whichever one the operator did not create would be unreachable
 * while looking, from the outside, exactly like a wrong password.
 *
 * The rules come from `http-contract.json` → `auth.identity` rather than being
 * retyped here, for the same reason every other schema fact in this backend comes
 * from the artifacts.
 *
 * ## Why ASCII case folding specifically
 *
 * `strtolower()` in PHP 8 is locale-independent and ASCII-only, which is what is
 * wanted. `mb_strtolower()` is not: under a Turkish locale it folds `I` to `ı`,
 * so the same address typed on two machines would produce two identities. The
 * contract states "ASCII case folding only" and this class is where that is true.
 */
final class AdminEmail implements \Stringable
{
    private function __construct(public readonly string $value)
    {
    }

    /**
     * @throws \InvalidArgumentException when the value cannot be an identifier.
     */
    public static function fromString(string $raw, ContractArtifacts $artifacts): self
    {
        $identity = self::identityRules($artifacts);
        $normalized = self::normalize($raw);

        if ($normalized === '') {
            throw new \InvalidArgumentException('The e-mail address is empty.');
        }

        if (mb_strlen($normalized, 'UTF-8') > $identity['maxLength']) {
            throw new \InvalidArgumentException(
                "The e-mail address exceeds {$identity['maxLength']} characters.",
            );
        }

        if (preg_match('/' . str_replace('/', '\/', $identity['pattern']) . '/u', $normalized) !== 1) {
            throw new \InvalidArgumentException('The e-mail address is not a valid address.');
        }

        return new self($normalized);
    }

    /**
     * The same normalisation, with no validation, for the login path.
     *
     * Login must not distinguish "malformed address" from "unknown address": both
     * are simply an address with no account, and answering them differently would
     * be an enumeration oracle in the one place the contract most insists there is
     * none ({@see \Eszter\Auth\Authenticator}). So a login lookup normalises and
     * then just fails to find anything, while *provisioning* — where the operator
     * is the one being helped — validates through {@see fromString()}.
     */
    public static function normalize(string $raw): string
    {
        return strtolower(trim($raw));
    }

    /** @return array{pattern: string, maxLength: int} */
    private static function identityRules(ContractArtifacts $artifacts): array
    {
        /** @var mixed $identity */
        $identity = $artifacts->authContract()['identity'] ?? null;

        if (!\is_array($identity)) {
            throw new \RuntimeException('http-contract.json has no auth.identity block.');
        }

        /** @var mixed $pattern */
        $pattern = $identity['pattern'] ?? null;
        /** @var mixed $maxLength */
        $maxLength = $identity['maxLength'] ?? null;

        if (!\is_string($pattern) || !\is_int($maxLength)) {
            throw new \RuntimeException('http-contract.json auth.identity is malformed.');
        }

        return ['pattern' => $pattern, 'maxLength' => $maxLength];
    }

    public function __toString(): string
    {
        return $this->value;
    }
}
