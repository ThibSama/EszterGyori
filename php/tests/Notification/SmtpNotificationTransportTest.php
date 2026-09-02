<?php

declare(strict_types=1);

namespace Eszter\Tests\Notification;

use Eszter\Config\SmtpSettings;
use Eszter\Notification\SmtpNotificationTransport;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Mailer\Transport\Smtp\EsmtpTransport;
use Symfony\Component\Mailer\Transport\Smtp\Stream\SocketStream;

/**
 * ESZ-102: the transport flags the SMTP transport produces for each
 * encryption mode.
 *
 * Pure no-network evidence: constructing an EsmtpTransport and setting its
 * flags performs no I/O, so the built object's own state is inspected through
 * the same private factory the production transport uses. The contract pinned
 * here is the one ESZ-074 implemented and ESZ-102 preserves: `starttls` is
 * mandatory TLS (opportunistic upgrade is on, but a server that offers no
 * STARTTLS is refused rather than downgraded), `smtps` is implicit TLS from
 * the first byte, and `none` — the development/test-only plaintext mode — is
 * the only one with TLS disabled and no upgrade path.
 */
final class SmtpNotificationTransportTest extends TestCase
{
    public function testStarttlsTransportRequiresTlsAndNeverDowngrades(): void
    {
        $transport = $this->transportFor('starttls');

        // Auto TLS is enabled, but requireTls makes the upgrade mandatory: a
        // server that cannot STARTTLS is refused, never served in plaintext.
        self::assertTrue($transport->isAutoTls(), 'starttls must allow the STARTTLS upgrade');
        self::assertTrue($transport->isTlsRequired(), 'starttls must refuse a no-TLS server');
        // No implicit TLS on connect: the socket starts plain and upgrades
        // in-band via the mandatory STARTTLS exchange.
        self::assertFalse($this->socket($transport)->isTLS(), 'starttls must not be implicit TLS');
    }

    public function testSmtpsTransportIsImplicitTls(): void
    {
        $transport = $this->transportFor('smtps');

        // TLS from the first byte, before any SMTP greeting.
        self::assertTrue($this->socket($transport)->isTLS(), 'smtps must be implicit TLS');
        // The connection is already encrypted; nothing opportunistic remains.
        self::assertFalse($transport->isAutoTls(), 'smtps must not attempt a STARTTLS upgrade');
        self::assertFalse($transport->isTlsRequired(), 'smtps needs no STARTTLS requirement');
    }

    public function testPlaintextModeIsTheOnlyOneWithoutAnyTlsPath(): void
    {
        $transport = $this->transportFor('none');

        self::assertFalse($this->socket($transport)->isTLS(), 'none must connect in plaintext');
        self::assertFalse($transport->isAutoTls(), 'none must never upgrade automatically');
        self::assertFalse($transport->isTlsRequired(), 'none must never require TLS');
    }

    public function testEncryptedModesPassTheConfiguredPortThroughUntouched(): void
    {
        // ESZ-102 invents no port policy: whatever port the deployment
        // configures is what the transport opens, for both encrypted modes.
        foreach (['starttls', 'smtps'] as $encryption) {
            $transport = $this->transportFor($encryption, 2587);

            self::assertSame(2587, $this->socket($transport)->getPort(), "{$encryption} port passthrough");
        }
    }

    private function transportFor(string $encryption, int $port = 587): EsmtpTransport
    {
        $factory = new \ReflectionMethod(SmtpNotificationTransport::class, 'smtp');
        $built = $factory->invoke(null, self::settings($encryption, $port));
        self::assertInstanceOf(EsmtpTransport::class, $built);
        /** @var EsmtpTransport $built */

        return $built;
    }

    private function socket(EsmtpTransport $transport): SocketStream
    {
        $stream = $transport->getStream();
        self::assertInstanceOf(SocketStream::class, $stream);
        /** @var SocketStream $stream */

        return $stream;
    }

    private static function settings(string $encryption, int $port = 587): SmtpSettings
    {
        return new SmtpSettings(
            'smtp.example.test',
            $port,
            $encryption,
            true,
            'mailer',
            'smtp-secret-value',
            'bonjour@example.test',
            'Eszter Gyori',
            10,
            'Répondez à cet e-mail.',
            'Prévenez-nous en cas d’empêchement.',
        );
    }
}
