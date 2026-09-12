<?php

declare(strict_types=1);

namespace Eszter\Privacy;

use Eszter\Booking\BookableServiceRepository;
use Eszter\Booking\Booking;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingHistoryEvent;
use Eszter\Booking\BookingHistoryRepository;
use Eszter\Booking\BookingRequestFields;
use Eszter\Notification\NotificationJob;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * The one export engine behind the rights of access and portability
 * (ESZ-164).
 *
 * ## One document, two representations
 *
 * {@see document()} builds the structured answer to "what do you hold about
 * me, and why": for each booking the request names, the held contact data,
 * the appointment facts, the basis evidence as stored, the non-personal
 * history trail and the delivery metadata of what was sent; beside them, the
 * information the customer is owed — controller, purposes, legal basis,
 * retention periods, recipient categories, source and the five V1 rights.
 * That array *is* the JSON representation (`privacyExportDocumentSchema` in
 * the HTTP contract validates it field by field), and {@see html()} renders
 * exactly that array as a readable French page. A fact cannot be present in
 * one representation and absent from the other, because there is only one.
 *
 * ## What the engine never does
 *
 * It writes nothing — no file, no row, no log line. The document exists in
 * the response and nowhere else, so no second copy of exported PII ever
 * needs its own retention. And it never reconstructs an anonymised booking:
 * a reference whose customer data has been erased appears as the reference
 * and the fact of its anonymisation, with no appointment, history or
 * delivery fact placed beside a requester's name that could reconnect the
 * row to the identity it no longer carries.
 */
final class PrivacyDataExport
{
    public const FORMAT = 'eszter.privacy-export';
    public const VERSION = 1;

    /** The information block, in the words of the booking form's own notice (booking-domain privacyNotices). */
    private const CONTROLLER = 'Eszter Gyori';
    private const CONTACT = 'contact@esztergyori.com';
    private const PURPOSES = [
        'Organiser le rendez-vous demandé : réservation, confirmation, rappel, déplacement ou annulation.',
        'Répondre aux demandes d’exercice des droits relatives à ce rendez-vous.',
    ];
    private const LEGAL_BASIS = 'Exécution de la prestation demandée et démarches précontractuelles effectuées à la'
        . ' demande de la personne (RGPD, art. 6, §1, b). Aucun consentement n’est requis pour cela.';
    private const RECIPIENTS = [
        'Eszter Gyori, responsable du traitement.',
        'Le prestataire d’hébergement du site et de sa base de données.',
        'Le prestataire d’envoi des e-mails (serveur SMTP), pour les messages relatifs au rendez-vous.',
    ];
    private const SOURCE = 'La personne elle-même, par le formulaire de réservation du site.';
    private const RIGHTS = [
        'Droit d’accès aux données détenues.',
        'Droit de rectification des données inexactes.',
        'Droit à l’effacement (anonymisation anticipée du rendez-vous).',
        'Droit à la limitation du traitement.',
        'Droit à la portabilité des données fournies.',
        'Droit d’introduire une réclamation auprès de la CNIL.',
    ];

    public function __construct(
        private readonly BookingDomainContract $contract,
        private readonly BookableServiceRepository $services,
        private readonly BookingHistoryRepository $history,
        private readonly NotificationJobRepository $jobs,
        private readonly Clock $clock,
    ) {
    }

    /**
     * The structured document — the JSON representation.
     *
     * @param list<Booking> $bookings The request's linked bookings, resolved
     *     by the caller in the request's stored order.
     * @return array<string, mixed>
     */
    public function document(PrivacyRequest $request, array $bookings): array
    {
        $retention = $this->contract->customerDataRetention;

        return [
            'format' => self::FORMAT,
            'version' => self::VERSION,
            'generatedAtUtc' => $this->clock->nowIso(),
            'request' => [
                'id' => $request->id,
                'type' => $request->type,
                'receivedDate' => $request->receivedDate,
            ],
            'information' => [
                'controller' => self::CONTROLLER,
                'purposes' => self::PURPOSES,
                'legalBasis' => self::LEGAL_BASIS,
                'retention' => [
                    \sprintf(
                        'Les coordonnées d’un rendez-vous honoré sont anonymisées %d jours après sa fin.',
                        $retention->confirmedExpiryDaysAfterEndsAtUtc,
                    ),
                    \sprintf(
                        'Les coordonnées d’un rendez-vous annulé sont anonymisées %d jours après son annulation.',
                        $retention->cancelledExpiryDaysAfterCancelledAtUtc,
                    ),
                    \sprintf(
                        'Les sauvegardes de l’application sont conservées au plus %d jours.',
                        $retention->backupArchiveRetentionDays,
                    ),
                    \sprintf(
                        'Le registre des demandes d’exercice des droits est conservé %d ans après la clôture'
                        . ' de la demande ; il ne contient ni adresse e-mail, ni message, ni copie des données.',
                        $this->contract->privacyRequests->closedRetentionYears,
                    ),
                ],
                'recipients' => self::RECIPIENTS,
                'source' => self::SOURCE,
                'rights' => self::RIGHTS,
                'contact' => self::CONTACT,
            ],
            'bookings' => array_map($this->bookingEntry(...), $bookings),
        ];
    }

    /**
     * The readable representation of {@see document()}: a standalone French
     * HTML page rendering every field of the document, and nothing that is
     * not in it.
     *
     * @param array<string, mixed> $document
     */
    public function html(array $document): string
    {
        $information = self::array($document, 'information');
        $request = self::array($document, 'request');
        $generated = self::string($document, 'generatedAtUtc');

        $sections = [];
        $sections[] = '<section><h2>Informations sur le traitement</h2><dl>'
            . self::definition('Responsable du traitement', self::string($information, 'controller'))
            . self::definitionList('Finalités', self::stringList($information, 'purposes'))
            . self::definition('Base juridique', self::string($information, 'legalBasis'))
            . self::definitionList('Durées de conservation', self::stringList($information, 'retention'))
            . self::definitionList('Destinataires', self::stringList($information, 'recipients'))
            . self::definition('Source des données', self::string($information, 'source'))
            . self::definitionList('Vos droits', self::stringList($information, 'rights'))
            . self::definition('Contact', self::string($information, 'contact'))
            . '</dl></section>';

        $bookings = $document['bookings'] ?? null;
        if (!\is_array($bookings)) {
            throw new \InvalidArgumentException('The export document has no bookings list.');
        }
        if ($bookings === []) {
            $sections[] = '<section><h2>Réservations concernées</h2>'
                . '<p>Aucune réservation n’est concernée par cette demande.</p></section>';
        }
        foreach ($bookings as $entry) {
            if (!\is_array($entry)) {
                throw new \InvalidArgumentException('The export document has a malformed booking entry.');
            }
            $sections[] = $this->bookingSection($entry);
        }

        return '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<title>' . self::escape('Vos données personnelles — ' . self::CONTROLLER) . '</title>'
            . '<style>body{font-family:Georgia,serif;max-width:52rem;margin:2rem auto;padding:0 1rem;'
            . 'color:#222;line-height:1.5}'
            . 'h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #ccc}'
            . 'dt{font-weight:bold;margin-top:.6rem}dd{margin:0 0 .3rem 1rem}'
            . 'table{border-collapse:collapse;width:100%;margin-top:.5rem}'
            . 'th,td{text-align:left;padding:.3rem .5rem;border-bottom:1px solid #ddd;vertical-align:top}'
            . 'p.meta{color:#555;font-size:.9rem}</style></head><body>'
            . '<h1>' . self::escape('Vos données personnelles — ' . self::CONTROLLER) . '</h1>'
            . '<p class="meta">'
            . self::escape(\sprintf(
                'Demande n° %d (%s), reçue le %s. Document généré le %s.',
                self::int($request, 'id'),
                self::typeLabel(self::string($request, 'type')),
                self::frenchDate(self::string($request, 'receivedDate')),
                self::frenchInstant($generated),
            ))
            . '</p>'
            . implode('', $sections)
            . '</body></html>';
    }

    /** The download name of a representation: the request id and the format, never a customer fact. */
    public function fileName(PrivacyRequest $request, string $format): string
    {
        return \sprintf('export-rgpd-demande-%d.%s', $request->id, $format);
    }

    /** @return array<string, mixed> */
    private function bookingEntry(Booking $booking): array
    {
        if ($booking->customerDataErasedAt !== null) {
            return ['reference' => $booking->reference, 'anonymised' => true];
        }

        return [
            'reference' => $booking->reference,
            'anonymised' => false,
            'appointment' => [
                'serviceKeys' => $booking->serviceKeys(),
                'serviceLabels' => array_map($this->serviceLabel(...), $booking->serviceKeys()),
                'state' => $booking->state->value,
                'startsAtUtc' => self::instant($booking->startsAtUtc),
                'endsAtUtc' => self::instant($booking->endsAtUtc),
                'timezone' => $booking->timezoneName,
                'createdAt' => $booking->createdAt,
                'cancelledAtUtc' => $booking->cancelledAtUtc === null ? null : self::instant($booking->cancelledAtUtc),
                'cancellationReason' => $booking->cancellationReason,
            ],
            'customer' => [
                'name' => $booking->customerName,
                'email' => $booking->customerEmail,
                'phone' => $booking->customerPhone,
                'note' => $booking->customerNote,
            ],
            'basis' => $this->basis($booking),
            'history' => array_map(
                static fn (BookingHistoryEvent $event): array => [
                    'type' => $event->type,
                    'actor' => $event->actor,
                    'occurredAt' => $event->occurredAt,
                ],
                $this->trail($booking->id),
            ),
            'notifications' => array_map(
                static fn (NotificationJob $job): array => [
                    'channel' => $job->channel,
                    'type' => $job->jobType,
                    'status' => $job->status,
                    'dueAtUtc' => self::instant($job->dueAtUtc),
                    'sentAtUtc' => $job->sentAtUtc === null ? null : self::instant($job->sentAtUtc),
                ],
                $this->jobs->forBooking($booking->id),
            ),
        ];
    }

    /**
     * The basis evidence exactly as stored: the privacy notice shown (with
     * its frozen wording) or the historical consent instant. Every live
     * booking carries exactly one of the two (migration 0021's CHECK).
     *
     * @return array<string, mixed>
     */
    private function basis(Booking $booking): array
    {
        if ($booking->privacyNoticeId !== null && $booking->privacyNoticePresentedAtUtc !== null) {
            return [
                'kind' => 'privacy_notice',
                'noticeId' => $booking->privacyNoticeId,
                'presentedAtUtc' => self::instant($booking->privacyNoticePresentedAtUtc),
                'text' => $this->contract->privacyRequests->noticeTexts[$booking->privacyNoticeId]
                    ?? throw new \RuntimeException('The stored privacy notice id names no catalog entry.'),
            ];
        }
        if ($booking->consentAtUtc !== null) {
            return [
                'kind' => 'consent',
                'noticeId' => $booking->consentNoticeId,
                'consentedAtUtc' => self::instant($booking->consentAtUtc),
            ];
        }

        throw new \RuntimeException('A live booking carries no basis evidence.');
    }

    /**
     * The whole trail of one booking, page by page through the same bounded
     * read the admin detail uses. Bounded by the domain's own page budget so
     * a pathological trail cannot make an export unbounded.
     *
     * @return list<BookingHistoryEvent>
     */
    private function trail(int $bookingId): array
    {
        $events = [];
        $after = null;
        for ($page = 0; $page < $this->contract->adminRangeMaxPages; ++$page) {
            $result = $this->history->pageForBooking($bookingId, $this->contract->adminHistoryPageSize, $after);
            foreach ($result['events'] as $event) {
                $events[] = $event;
            }
            if (!$result['hasMore'] || $result['events'] === []) {
                return $events;
            }
            $after = $result['events'][\count($result['events']) - 1]->id;
        }

        return $events;
    }

    private function serviceLabel(string $key): string
    {
        return $this->services->find($key)->label ?? $key;
    }

    /** @param array<mixed> $entry */
    private function bookingSection(array $entry): string
    {
        $reference = self::string($entry, 'reference');
        if (($entry['anonymised'] ?? null) === true) {
            return '<section><h2>' . self::escape('Réservation ' . $reference) . '</h2>'
                . '<p>' . self::escape(
                    'Les données personnelles de cette réservation ont été anonymisées :'
                    . ' aucune donnée vous concernant n’est plus détenue pour celle-ci.',
                ) . '</p></section>';
        }

        $appointment = self::array($entry, 'appointment');
        $customer = self::array($entry, 'customer');
        $basis = self::array($entry, 'basis');

        $html = '<section><h2>' . self::escape('Réservation ' . $reference) . '</h2>';
        $html .= '<h3>Rendez-vous</h3><dl>'
            . self::definition('Prestation', implode(' + ', self::stringList($appointment, 'serviceLabels')))
            . self::definition('État', self::string($appointment, 'state') === 'cancelled' ? 'Annulé' : 'Confirmé')
            . self::definition('Début (Paris)', self::frenchInstant(self::string($appointment, 'startsAtUtc')))
            . self::definition('Fin (Paris)', self::frenchInstant(self::string($appointment, 'endsAtUtc')))
            . self::definition('Réservé le', self::frenchInstant(self::string($appointment, 'createdAt')))
            . (\is_string($appointment['cancelledAtUtc'] ?? null)
                ? self::definition('Annulé le', self::frenchInstant($appointment['cancelledAtUtc']))
                : '')
            . (\is_string($appointment['cancellationReason'] ?? null)
                ? self::definition('Motif d’annulation', $appointment['cancellationReason'])
                : '')
            . '</dl>';
        $html .= '<h3>Vos coordonnées</h3><dl>'
            . self::definition('Nom', self::string($customer, 'name'))
            . self::definition('Adresse e-mail', self::string($customer, 'email'))
            . self::definition('Téléphone', \is_string($customer['phone'] ?? null) ? $customer['phone'] : '—')
            . self::definition('Note', \is_string($customer['note'] ?? null) ? $customer['note'] : '—')
            . '</dl>';
        $html .= '<h3>Information reçue lors de la réservation</h3><dl>';
        if (self::string($basis, 'kind') === 'privacy_notice') {
            $html .= self::definition('Notice affichée le', self::frenchInstant(self::string($basis, 'presentedAtUtc')))
                . self::definition('Texte de la notice', self::string($basis, 'text'));
        } else {
            $html .= self::definition(
                'Consentement recueilli le',
                self::frenchInstant(self::string($basis, 'consentedAtUtc')),
            );
        }
        $html .= '</dl>';

        $history = $entry['history'] ?? null;
        $html .= '<h3>Historique</h3>';
        if (\is_array($history) && $history !== []) {
            $html .= '<table><thead><tr><th>Événement</th><th>Par</th><th>Le</th></tr></thead><tbody>';
            foreach ($history as $event) {
                if (!\is_array($event)) {
                    continue;
                }
                $html .= '<tr><td>' . self::escape(self::historyLabel(self::string($event, 'type'))) . '</td>'
                    . '<td>' . self::escape(self::string($event, 'actor') === 'admin' ? 'Le salon' : 'Vous') . '</td>'
                    . '<td>' . self::escape(self::frenchInstant(self::string($event, 'occurredAt'))) . '</td></tr>';
            }
            $html .= '</tbody></table>';
        } else {
            $html .= '<p>Aucun événement.</p>';
        }

        $notifications = $entry['notifications'] ?? null;
        $html .= '<h3>Messages relatifs au rendez-vous</h3>';
        if (\is_array($notifications) && $notifications !== []) {
            $html .= '<table><thead><tr><th>Message</th><th>Canal</th><th>Statut</th>'
                . '<th>Prévu le</th><th>Envoyé le</th></tr></thead><tbody>';
            foreach ($notifications as $job) {
                if (!\is_array($job)) {
                    continue;
                }
                $html .= '<tr><td>' . self::escape(self::jobLabel(self::string($job, 'type'))) . '</td>'
                    . '<td>' . self::escape(self::string($job, 'channel') === 'sms' ? 'SMS' : 'E-mail') . '</td>'
                    . '<td>' . self::escape(self::statusLabel(self::string($job, 'status'))) . '</td>'
                    . '<td>' . self::escape(self::frenchInstant(self::string($job, 'dueAtUtc'))) . '</td>'
                    . '<td>' . self::escape(
                        \is_string($job['sentAtUtc'] ?? null) ? self::frenchInstant($job['sentAtUtc']) : '—',
                    ) . '</td></tr>';
            }
            $html .= '</tbody></table>';
        } else {
            $html .= '<p>Aucun message.</p>';
        }

        return $html . '</section>';
    }

    private static function typeLabel(string $type): string
    {
        return match ($type) {
            'access' => 'accès',
            'portability' => 'portabilité',
            'rectification' => 'rectification',
            'erasure' => 'effacement',
            'restriction' => 'limitation',
            default => $type,
        };
    }

    private static function historyLabel(string $type): string
    {
        return match ($type) {
            'created' => 'Réservation',
            'moved' => 'Déplacement',
            'cancelled' => 'Annulation',
            'customer_updated' => 'Coordonnées modifiées',
            'customer_data_erased' => 'Anonymisation',
            'processing_restricted' => 'Limitation du traitement',
            'processing_restriction_lifted' => 'Levée de la limitation',
            default => $type,
        };
    }

    private static function jobLabel(string $type): string
    {
        return match ($type) {
            'booking_confirmation' => 'Confirmation',
            'booking_reminder' => 'Rappel',
            'booking_cancellation' => 'Annulation',
            'booking_moved' => 'Déplacement',
            'processing_restriction_lifted' => 'Levée de la limitation',
            default => $type,
        };
    }

    private static function statusLabel(string $status): string
    {
        return match ($status) {
            'pending' => 'À envoyer',
            'processing' => 'En cours d’envoi',
            'sent' => 'Envoyé',
            'failed' => 'Échec',
            'skipped' => 'Non envoyé',
            'retired' => 'Retiré',
            default => $status,
        };
    }

    private static function instant(string $databaseInstant): string
    {
        return IsoTimestamp::format(BookingRequestFields::databaseInstant($databaseInstant));
    }

    private static function frenchInstant(string $iso): string
    {
        $instant = \DateTimeImmutable::createFromFormat(IsoTimestamp::FORMAT, $iso, new \DateTimeZone('UTC'));
        if ($instant === false) {
            throw new \InvalidArgumentException('The export document holds a non-canonical instant.');
        }

        return $instant->setTimezone(new \DateTimeZone('Europe/Paris'))->format('d/m/Y à H:i');
    }

    private static function frenchDate(string $date): string
    {
        $day = \DateTimeImmutable::createFromFormat('!Y-m-d', $date, new \DateTimeZone('UTC'));
        if ($day === false) {
            throw new \InvalidArgumentException('The export document holds a malformed date.');
        }

        return $day->format('d/m/Y');
    }

    private static function definition(string $term, string $value): string
    {
        return '<dt>' . self::escape($term) . '</dt><dd>' . self::escape($value) . '</dd>';
    }

    /** @param list<string> $values */
    private static function definitionList(string $term, array $values): string
    {
        return '<dt>' . self::escape($term) . '</dt><dd><ul>'
            . implode('', array_map(
                static fn (string $value): string => '<li>' . self::escape($value) . '</li>',
                $values,
            ))
            . '</ul></dd>';
    }

    private static function escape(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }

    /**
     * @param array<mixed> $source
     * @return array<string, mixed>
     */
    private static function array(array $source, string $key): array
    {
        $value = $source[$key] ?? null;
        if (!\is_array($value)) {
            throw new \InvalidArgumentException("The export document has no `{$key}` block.");
        }
        /** @var array<string, mixed> $value */
        return $value;
    }

    /** @param array<mixed> $source */
    private static function string(array $source, string $key): string
    {
        $value = $source[$key] ?? null;
        if (!\is_string($value)) {
            throw new \InvalidArgumentException("The export document has no `{$key}` string.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function int(array $source, string $key): int
    {
        $value = $source[$key] ?? null;
        if (!\is_int($value)) {
            throw new \InvalidArgumentException("The export document has no `{$key}` integer.");
        }

        return $value;
    }

    /**
     * @param array<mixed> $source
     * @return list<string>
     */
    private static function stringList(array $source, string $key): array
    {
        $value = $source[$key] ?? null;
        if (!\is_array($value)) {
            throw new \InvalidArgumentException("The export document has no `{$key}` list.");
        }
        $strings = [];
        foreach ($value as $item) {
            if (!\is_string($item)) {
                throw new \InvalidArgumentException("The export document `{$key}` list holds a non-string.");
            }
            $strings[] = $item;
        }

        return $strings;
    }
}
