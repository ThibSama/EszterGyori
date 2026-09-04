<?php

declare(strict_types=1);

namespace Eszter\Support;

/** Produces a correlatable login identity without retaining the submitted address. */
final class LoginIdentityPseudonymizer
{
    /** Purpose and format version prevent cross-use of the configured key. */
    private const DOMAIN = "eszter:login-identity:v1\0";

    /** @param string $key Dedicated high-entropy application secret. */
    public function __construct(private readonly string $key)
    {
    }

    /**
     * @param string $normalizedIdentity Identity normalized by the authentication domain.
     * @return string Full lowercase 64-character HMAC-SHA256 hex digest.
     */
    public function fingerprint(string $normalizedIdentity): string
    {
        return hash_hmac('sha256', self::DOMAIN . $normalizedIdentity, $this->key);
    }
}
