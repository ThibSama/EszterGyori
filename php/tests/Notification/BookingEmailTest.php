<?php

declare(strict_types=1);

namespace Eszter\Tests\Notification;

use Eszter\Config\SmtpSettings;
use Eszter\Notification\BookingEmailRenderer;
use Eszter\Notification\BookingNotificationFacts;
use Eszter\Notification\BookingNotificationFactsProvider;
use Eszter\Notification\NotificationJob;
use Eszter\Notification\PermanentDeliveryException;
use Eszter\Notification\SmtpFailureClassifier;
use Eszter\Notification\SmtpNotificationTransport;
use Eszter\Notification\TransientDeliveryException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Mailer\Exception\TransportException;
use Symfony\Component\Mime\Email;

final class BookingEmailTest extends TestCase
{
    #[DataProvider('templates')]
    public function testEveryTemplateContainsOnlyCustomerFacingFacts(string $type, string $title): void
    {
        $message = (new BookingEmailRenderer($this->settings()))->render(new BookingNotificationFacts(
            'cliente@example.test',
            'Sourcils <script>alert("x")</script>',
            new \DateTimeImmutable('2026-10-25T01:30:00.000Z'),
            'bk_0123456789abcdef0123456789abcdef',
            $type,
        ));

        self::assertSame($title, $message->subject);
        self::assertStringContainsString('25/10/2026 à 02:30', $message->text);
        self::assertStringContainsString('Sourcils <script>alert("x")</script>', $message->text);
        self::assertStringContainsString('Référence : bk_0123456789abcdef0123456789abcdef', $message->text);
        self::assertStringContainsString('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;', $message->html);
        self::assertStringNotContainsString('<script>', $message->html);
        self::assertStringContainsString('Contact &lt;salon&gt;', $message->html);
        self::assertStringNotContainsString('cliente@example.test', $message->text . $message->html);
        self::assertStringNotContainsString('booking_id', $message->text . $message->html);
    }

    /** @return iterable<string, array{string, string}> */
    public static function templates(): iterable
    {
        yield 'confirmation' => ['booking_confirmation', 'Votre rendez-vous est confirmé'];
        yield 'reminder' => ['booking_reminder', 'Rappel de votre rendez-vous'];
        yield 'move' => ['booking_moved', 'Votre rendez-vous a été déplacé'];
        yield 'cancellation' => ['booking_cancellation', 'Votre rendez-vous est annulé'];
    }

    public function testSmtpResponseClassesMapToSafeRetryOutcomes(): void
    {
        $classifier = new SmtpFailureClassifier();
        $transient = $classifier->classify(new TransportException('secret recipient@example.test', 451));
        $permanent = $classifier->classify(new TransportException('secret recipient@example.test', 550));
        $network = $classifier->classify(new \RuntimeException('password=secret'));

        self::assertInstanceOf(TransientDeliveryException::class, $transient);
        self::assertSame('smtp_transient', $transient->getMessage());
        self::assertInstanceOf(PermanentDeliveryException::class, $permanent);
        self::assertSame('smtp_rejected', $permanent->getMessage());
        self::assertInstanceOf(TransientDeliveryException::class, $network);
        self::assertSame('smtp_transient', $network->getMessage());
    }

    public function testSmtpTransportBuildsTheRenderedMultipartMessageWithoutNetwork(): void
    {
        $facts = new BookingNotificationFacts(
            'cliente@example.test',
            'Sourcils',
            new \DateTimeImmutable('2026-06-15T07:00:00.000Z'),
            'bk_0123456789abcdef0123456789abcdef',
            'booking_confirmation',
        );
        $provider = new class ($facts) implements BookingNotificationFactsProvider {
            public function __construct(private readonly BookingNotificationFacts $facts)
            {
            }

            public function forJob(NotificationJob $job): BookingNotificationFacts
            {
                return $this->facts;
            }
        };
        $mailer = new RecordingMailer();
        $settings = $this->settings();
        $transport = new SmtpNotificationTransport(
            $settings,
            $provider,
            new BookingEmailRenderer($settings),
            new SmtpFailureClassifier(),
            $mailer,
        );

        $transport->deliver($this->job());

        self::assertInstanceOf(Email::class, $mailer->message);
        self::assertSame('bonjour@example.test', $mailer->message->getFrom()[0]->getAddress());
        self::assertSame('cliente@example.test', $mailer->message->getTo()[0]->getAddress());
        self::assertSame('Votre rendez-vous est confirmé', $mailer->message->getSubject());
        self::assertStringContainsString('15/06/2026 à 09:00', (string) $mailer->message->getTextBody());
        self::assertStringContainsString('<html', (string) $mailer->message->getHtmlBody());
    }

    private function job(): NotificationJob
    {
        return new NotificationJob(
            1,
            'bk_0123456789abcdef0123456789abcdef.email.booking_confirmation',
            2,
            'bk_0123456789abcdef0123456789abcdef',
            'email',
            'booking_confirmation',
            '2026-06-13 12:00:00.000',
            '2026-06-13 12:00:00.000',
            'processing',
            1,
            null,
            null,
            'host.123.abcdef123456',
            '2026-06-13 12:05:00.000',
        );
    }

    private function settings(): SmtpSettings
    {
        return new SmtpSettings(
            'smtp.example.test',
            587,
            'starttls',
            true,
            'mailer',
            'secret',
            'bonjour@example.test',
            'Eszter Gyori',
            10,
            'Contact <salon>',
            'Prévenez-nous & arrivez à l’heure.',
        );
    }
}
