<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Config\SmtpSettings;
use Symfony\Component\Mailer\Mailer;
use Symfony\Component\Mailer\MailerInterface;
use Symfony\Component\Mailer\Transport\Smtp\EsmtpTransport;
use Symfony\Component\Mailer\Transport\Smtp\Stream\SocketStream;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;

/** Production SMTP implementation behind the provider-neutral transport seam. */
final class SmtpNotificationTransport implements NotificationTransport
{
    private readonly MailerInterface $mailer;

    public function __construct(
        private readonly SmtpSettings $settings,
        private readonly BookingNotificationFactsProvider $facts,
        private readonly BookingEmailRenderer $renderer,
        private readonly SmtpFailureClassifier $failures = new SmtpFailureClassifier(),
        ?MailerInterface $mailer = null,
    ) {
        $this->mailer = $mailer ?? new Mailer(self::smtp($settings));
    }

    public function channel(): string
    {
        return 'email';
    }

    public function deliver(NotificationJob $job): void
    {
        $facts = $this->facts->forJob($job);
        $message = $this->renderer->render($facts);
        $email = (new Email())
            ->from(new Address($this->settings->senderAddress, $this->settings->senderName))
            ->to($facts->recipientAddress)
            ->subject($message->subject)
            ->text($message->text)
            ->html($message->html);

        try {
            $this->mailer->send($email);
        } catch (\Throwable $failure) {
            throw $this->failures->classify($failure);
        }
    }

    private static function smtp(SmtpSettings $settings): EsmtpTransport
    {
        $implicitTls = $settings->encryption === 'smtps';
        $transport = new EsmtpTransport($settings->host, $settings->port, $implicitTls);

        if ($settings->encryption === 'starttls') {
            $transport->setAutoTls(true);
            $transport->setRequireTls(true);
        } else {
            $transport->setAutoTls(false);
            $transport->setRequireTls(false);
        }

        $stream = $transport->getStream();
        if (!$stream instanceof SocketStream) {
            throw new NotificationException('SMTP transport did not provide a socket stream.');
        }
        $stream->setTimeout((float) $settings->timeoutSeconds);

        if ($settings->authenticationRequired) {
            $transport->setUsername($settings->username ?? '');
            $transport->setPassword($settings->password ?? '');
        }

        return $transport;
    }
}
