<?php

declare(strict_types=1);

namespace Eszter\Tests\Retention;

use Eszter\Notification\NotificationPolicy;
use Eszter\Retention\RetentionPolicy;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The frozen ESZ-140 retention policy, read from the generated artifact.
 *
 * No database. Everything here is decidable from the frozen contract, and
 * keeping it out of the SQL gates means a contributor without MySQL still
 * finds out that they changed a frozen placeholder or bound.
 */
final class RetentionPolicyTest extends TestCase
{
    private RetentionPolicy $policy;

    protected function setUp(): void
    {
        $this->policy = RetentionPolicy::fromArtifacts(TestEnvironment::artifacts());
    }

    public function testTheFrozenPolicyIsTheDeclaredV1ProductPolicy(): void
    {
        self::assertSame(90, $this->policy->confirmedExpiryDaysAfterEndsAtUtc);
        self::assertSame(90, $this->policy->cancelledExpiryDaysAfterCancelledAtUtc);
        self::assertSame(30, $this->policy->backupArchiveRetentionDays);
        self::assertSame('Deleted customer', $this->policy->erasedCustomerName);
        self::assertSame('erased@example.invalid', $this->policy->erasedCustomerEmail);
        self::assertSame('customer_data_erased', $this->policy->erasureJobCode);
    }

    public function testThePlaceholdersSatisfyTheCustomerValidationRulesTheBookingsTableEnforces(): void
    {
        // name and e-mail are required columns with length CHECKs, and the
        // booking write path validates e-mail shape with the same filter — an
        // erased row must still satisfy every constraint that applies to a live
        // row, or the schema would refuse its own erasure.
        self::assertGreaterThan(0, mb_strlen($this->policy->erasedCustomerName));
        self::assertLessThanOrEqual(160, mb_strlen($this->policy->erasedCustomerName));

        self::assertGreaterThanOrEqual(3, mb_strlen($this->policy->erasedCustomerEmail));
        self::assertLessThanOrEqual(254, mb_strlen($this->policy->erasedCustomerEmail));
        self::assertNotFalse(filter_var($this->policy->erasedCustomerEmail, FILTER_VALIDATE_EMAIL));
    }

    public function testTheEmailPlaceholderIsNonDeliverableAndTheNameIsNotAnEmail(): void
    {
        // `.invalid` is reserved by RFC 2606 and unrouteable: the placeholder
        // address is syntactically valid but cannot be delivered to, which is
        // the whole point of a placeholder that is never supposed to receive
        // mail.
        self::assertStringEndsWith('.invalid', $this->policy->erasedCustomerEmail);

        // The name placeholder must not be able to double as an address or to
        // carry a fragment of one.
        self::assertStringNotContainsString('@', $this->policy->erasedCustomerName);
        self::assertStringNotContainsString($this->policy->erasedCustomerEmail, $this->policy->erasedCustomerName);
    }

    public function testTheErasureCodeIsAFrozenReservedNotificationCode(): void
    {
        $notifications = NotificationPolicy::fromArtifacts(TestEnvironment::artifacts());

        self::assertTrue($notifications->acceptsErrorCode($this->policy->erasureJobCode));
        self::assertContains($this->policy->erasureJobCode, $notifications->reservedErrorCodes);
        self::assertTrue($this->policy->isErasureCode($this->policy->erasureJobCode));
        self::assertFalse($this->policy->isErasureCode('transport_transient'));
    }

    public function testThePlaceholdersAreFixedAsciiValuesNeverDerivedFromTheCustomer(): void
    {
        // Erasure is recognisable, deterministic and byte-exact across the
        // artifact, the PHP writer and the SQL CHECK that restates it. ASCII
        // keeps that byte-exactness trivial; a value derived from the customer
        // (a hash, an initial, a truncated name) would still be identifying
        // and is exactly what the policy forbids.
        foreach ([$this->policy->erasedCustomerName, $this->policy->erasedCustomerEmail] as $placeholder) {
            self::assertMatchesRegularExpression('/^[\x20-\x7E]+$/', $placeholder, 'placeholder is not plain ASCII');
            self::assertSame($placeholder, trim($placeholder));
        }
    }
}
