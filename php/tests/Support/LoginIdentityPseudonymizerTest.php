<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Support\LoginIdentityPseudonymizer;
use PHPUnit\Framework\TestCase;

final class LoginIdentityPseudonymizerTest extends TestCase
{
    public function testTheFingerprintIsDeterministicKeyedAndDomainSeparated(): void
    {
        $identity = 'customer@example.test';
        $first = new LoginIdentityPseudonymizer(str_repeat('a', 64));
        $second = new LoginIdentityPseudonymizer(str_repeat('b', 64));

        self::assertSame($first->fingerprint($identity), $first->fingerprint($identity));
        self::assertNotSame($first->fingerprint($identity), $first->fingerprint('other@example.test'));
        self::assertNotSame($first->fingerprint($identity), $second->fingerprint($identity));
        self::assertNotSame(hash('sha256', $identity), $first->fingerprint($identity));
        self::assertNotSame(hash_hmac('sha256', $identity, str_repeat('a', 64)), $first->fingerprint($identity));
    }
}
