<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Config\SmtpSettings;

/** Pure text + HTML booking template renderer (ESZ-073/074). */
final class BookingEmailRenderer
{
    private const TITLES = [
        'booking_confirmation' => 'Votre rendez-vous est confirmé',
        'booking_reminder' => 'Rappel de votre rendez-vous',
        'booking_cancellation' => 'Votre rendez-vous est annulé',
        'booking_moved' => 'Votre rendez-vous a été déplacé',
    ];

    public function __construct(private readonly SmtpSettings $settings)
    {
    }

    public function render(BookingNotificationFacts $facts): BookingNotificationMessage
    {
        $title = self::TITLES[$facts->jobType] ?? null;
        if ($title === null) {
            throw NotificationException::invalid('jobType', 'has no e-mail template.');
        }

        $service = self::plain($facts->serviceLabel);
        $reference = self::plain($facts->bookingReference);
        $contact = self::plain($this->settings->customerContact);
        $instructions = self::plain($this->settings->customerInstructions);
        $local = $facts->startsAtUtc
            ->setTimezone(new \DateTimeZone('Europe/Paris'))
            ->format('d/m/Y à H:i');

        $text = implode("\n", [
            $title,
            '',
            "Prestation : {$service}",
            "Date et heure (Paris) : {$local}",
            "Référence : {$reference}",
            '',
            $instructions,
            $contact,
        ]);

        $html = '<!doctype html><html lang="fr"><body>'
            . '<h1>' . self::html($title) . '</h1>'
            . '<dl><dt>Prestation</dt><dd>' . self::html($service) . '</dd>'
            . '<dt>Date et heure (Paris)</dt><dd>' . self::html($local) . '</dd>'
            . '<dt>Référence</dt><dd>' . self::html($reference) . '</dd></dl>'
            . '<p>' . self::html($instructions) . '</p>'
            . '<p>' . self::html($contact) . '</p>'
            . '</body></html>';

        return new BookingNotificationMessage($title, $text, $html);
    }

    private static function plain(string $value): string
    {
        return trim(preg_replace('/[\x00-\x1F\x7F\s]+/u', ' ', $value) ?? '');
    }

    private static function html(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }
}
