<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;
use Eszter\Notification\BookingNotificationProducer;
use Eszter\Notification\DurableBookingNotificationProducer;
use Eszter\Notification\NotificationCatchUpPolicy;
use Eszter\Notification\NotificationChannelSettings;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\NotificationPolicy;
use Eszter\Notification\NotificationScheduler;

/** Package 4.3 application service with MySQL-owned concurrency control. */
final class PdoBookingApi implements BookingApi
{
    /**
     * The widest window the availability editor may ask for in one read.
     *
     * Mirrors `ADMIN_AVAILABILITY_MAX_RANGE_DAYS` in the frozen HTTP contract,
     * where it is also recorded in `booking.availabilityAdministration`. It is a
     * relation between two request fields, so JSON Schema cannot express it and
     * the server has to be the one that says no.
     */
    private const MAX_AVAILABILITY_RANGE_DAYS = 400;

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly BookingDomainContract $contract,
        private readonly BookingTimePolicy $time,
        private readonly BookableServiceRepository $services,
        private readonly AvailabilityRepository $availabilityRepository,
        private readonly BookingRepository $bookings,
        private readonly BookingHistoryRepository $history,
        private readonly SlotEngine $slots,
        private readonly BookingNotificationProducer $notifications,
    ) {
    }

    public static function createDefault(
        Database $database,
        Clock $clock,
        BookingDomainContract $contract,
        NotificationPolicy $notificationPolicy,
        ?BookingNotificationProducer $notificationProducer = null,
    ): self {
        $time = new BookingTimePolicy($contract);
        $services = new BookableServiceRepository($database, $clock, $contract);
        $bookings = new BookingRepository(
            $database,
            $clock,
            $contract,
            $time,
            $services,
            new BookingStateMachine($contract),
        );

        $jobs = new NotificationJobRepository($database, $clock, $notificationPolicy);
        $scheduler = new NotificationScheduler(
            $jobs,
            new NotificationCatchUpPolicy(
                new NotificationChannelSettings($database, $clock, $notificationPolicy),
                $notificationPolicy,
                $clock,
            ),
        );

        return new self(
            $database,
            $clock,
            $contract,
            $time,
            $services,
            new AvailabilityRepository($database, $clock, $contract, $time),
            $bookings,
            new BookingHistoryRepository($database, $clock),
            new SlotEngine($contract, $time),
            $notificationProducer ?? new DurableBookingNotificationProducer($scheduler, $jobs, $clock),
        );
    }

    /** @return array<string, mixed> */
    public function services(): array
    {
        return [
            'services' => array_map(
                static fn (BookableService $service): array => [
                    'key' => $service->key,
                    'label' => $service->label,
                    'durationMinutes' => $service->durationMinutes,
                ],
                $this->services->all(true),
            ),
        ];
    }

    /** @return array<string, mixed> */
    public function availability(array $request): array
    {
        $serviceKey = self::requiredString($request, 'serviceKey');
        $fromDate = self::requiredString($request, 'fromDate');
        $untilDate = self::requiredString($request, 'untilDate');
        $this->assertPublicRange($fromDate, $untilDate);
        $service = $this->activeService($serviceKey);
        $slots = $this->compute($service, $fromDate, $untilDate);

        return [
            'serviceKey' => $service->key,
            'timezone' => $this->contract->timezone,
            'fromDate' => $fromDate,
            'untilDate' => $untilDate,
            'slots' => array_map($this->slotPayload(...), $slots),
        ];
    }

    /** @return array<string, mixed> */
    public function create(array $request): array
    {
        $serviceKey = self::requiredString($request, 'serviceKey');
        $requestedStart = self::timestamp($request, 'startsAtUtc');
        $name = self::requiredString($request, 'customerName');
        $email = self::requiredString($request, 'customerEmail');
        $phone = self::nullableString($request, 'customerPhone');
        $note = self::nullableString($request, 'customerNote');
        if (($request['consentAccepted'] ?? null) !== true) {
            throw new BookingValidationException('consentAccepted', 'Booking consent must be explicit.');
        }
        $localDate = $requestedStart->setTimezone(new \DateTimeZone($this->contract->timezone))->format('Y-m-d');
        $this->assertPublicRange($localDate, $localDate);

        $booking = $this->database->transactional(function () use (
            $serviceKey,
            $requestedStart,
            $localDate,
            $name,
            $email,
            $phone,
            $note,
        ): Booking {
            $this->lockResource();
            $service = $this->activeService($serviceKey);
            $slot = $this->requestedSlot($service, $localDate, $requestedStart);
            $booking = $this->bookings->createConfirmed(
                $serviceKey,
                $slot->startsAtUtc,
                $slot->endsAtUtc,
                $name,
                $email,
                $phone,
                $note,
                $this->clock->now(),
            );
            $this->history->append($booking->id, 'created', 'public');
            $this->notifications->created($booking);

            return $booking;
        });

        return $this->publicBookingPayload($booking);
    }

    /** @return array<string, mixed> */
    public function adminQuery(array $request): array
    {
        $mode = self::requiredString($request, 'mode');
        if ($mode === 'reference') {
            $booking = $this->bookings->find(self::requiredString($request, 'reference'));
            if ($booking === null) {
                throw new BookingNotFoundException(self::requiredString($request, 'reference'));
            }
            $bookings = [$booking];
        } elseif ($mode === 'range') {
            $from = self::date(self::requiredString($request, 'fromDate'), 'fromDate');
            $until = self::date(self::requiredString($request, 'untilDate'), 'untilDate');
            $days = (int) $from->diff($until)->format('%r%a') + 1;
            if ($days < 1 || $days > $this->contract->slotMaxHorizonDays) {
                throw new BookingValidationException('untilDate', 'Admin booking range is invalid or too large.');
            }
            [$fromUtc, $untilUtc] = $this->utcRange($from->format('Y-m-d'), $until->format('Y-m-d'));
            $bookings = $this->bookings->listBetween($fromUtc, $untilUtc);
        } else {
            throw new BookingValidationException('mode', 'Unknown admin booking query mode.');
        }

        return ['bookings' => array_map($this->adminBookingPayload(...), $bookings)];
    }

    /** @return array<string, mixed> */
    public function adminMoveAvailability(array $request): array
    {
        $reference = self::requiredString($request, 'reference');
        $fromDate = self::requiredString($request, 'fromDate');
        $untilDate = self::requiredString($request, 'untilDate');
        $this->assertPublicRange($fromDate, $untilDate);
        $booking = $this->bookings->find($reference);
        if ($booking === null) {
            throw new BookingNotFoundException($reference);
        }
        if ($booking->state->value !== 'confirmed') {
            throw new InvalidBookingTransitionException($booking->state->value, 'moved');
        }
        $service = $this->activeService($booking->serviceKey);

        return [
            'serviceKey' => $service->key,
            'timezone' => $this->contract->timezone,
            'fromDate' => $fromDate,
            'untilDate' => $untilDate,
            'slots' => array_map(
                $this->slotPayload(...),
                $this->compute($service, $fromDate, $untilDate, $reference),
            ),
        ];
    }

    /** @return array<string, mixed> */
    public function adminMutate(array $request): array
    {
        $action = self::requiredString($request, 'action');
        $reference = self::requiredString($request, 'reference');

        $booking = match ($action) {
            'update' => $this->updateCustomer($reference, $request),
            'move' => $this->move($reference, self::timestamp($request, 'startsAtUtc')),
            'cancel' => $this->cancel($reference, self::nullableString($request, 'reason')),
            default => throw new BookingValidationException('action', 'Unknown booking action.'),
        };

        return ['booking' => $this->adminBookingPayload($booking)];
    }

    /**
     * ESZ-065 — the operational summary.
     *
     * One bounded read of the same rows `adminQuery` returns, partitioned by
     * Paris-local date and by state. Cancelled bookings are counted in their own
     * fields and never appear in a listed entry, so the confirmed numbers can
     * only ever go down when something is cancelled.
     *
     * @return array<string, mixed>
     */
    public function adminSummary(array $request): array
    {
        $upcomingDays = self::requiredInt($request, 'upcomingDays');
        if ($upcomingDays < 1 || $upcomingDays > $this->contract->slotMaxHorizonDays) {
            throw new BookingValidationException('upcomingDays', 'Summary horizon is outside the supported range.');
        }

        $zone = new \DateTimeZone($this->contract->timezone);
        $now = $this->clock->now();
        $today = $now->setTimezone($zone)->format('Y-m-d');
        $untilDate = self::date($today, 'todayDate')
            ->modify('+' . ($upcomingDays - 1) . ' days')
            ->format('Y-m-d');
        [$fromUtc, $untilUtc] = $this->utcRange($today, $untilDate);

        $todayConfirmed = 0;
        $todayCancelled = 0;
        $upcomingConfirmed = 0;
        $upcomingCancelled = 0;
        $todayEntries = [];
        $upcomingEntries = [];
        $next = null;

        foreach ($this->bookings->listBetween($fromUtc, $untilUtc) as $booking) {
            $start = self::databaseInstant($booking->startsAtUtc);
            $isToday = $start->setTimezone($zone)->format('Y-m-d') === $today;

            if ($booking->state->value !== 'confirmed') {
                if ($isToday) {
                    ++$todayCancelled;
                } else {
                    ++$upcomingCancelled;
                }

                continue;
            }

            if ($isToday) {
                ++$todayConfirmed;
                $todayEntries[] = $this->summaryEntry($booking, $zone);
            } else {
                ++$upcomingConfirmed;
                $upcomingEntries[] = $this->summaryEntry($booking, $zone);
            }

            // `listBetween` is ordered by start, so the first confirmed booking
            // that has not already begun is the next one.
            if ($next === null && $start >= $now) {
                $next = IsoTimestamp::format($start);
            }
        }

        return [
            'timezone' => $this->contract->timezone,
            'todayDate' => $today,
            'untilDate' => $untilDate,
            'upcomingDays' => $upcomingDays,
            'counts' => [
                'todayConfirmed' => $todayConfirmed,
                'todayCancelled' => $todayCancelled,
                'upcomingConfirmed' => $upcomingConfirmed,
                'upcomingCancelled' => $upcomingCancelled,
            ],
            'nextConfirmedStartsAtUtc' => $next,
            'today' => $todayEntries,
            'upcoming' => $upcomingEntries,
        ];
    }

    /**
     * ESZ-063/064 — the stored schedule, read back.
     *
     * @return array<string, mixed>
     */
    public function adminAvailability(array $request): array
    {
        $fromDate = self::requiredString($request, 'fromDate');
        $untilDate = self::requiredString($request, 'untilDate');
        $from = self::date($fromDate, 'fromDate');
        $until = self::date($untilDate, 'untilDate');
        $days = (int) $from->diff($until)->format('%r%a') + 1;
        if ($days < 1 || $days > self::MAX_AVAILABILITY_RANGE_DAYS) {
            throw new BookingValidationException('untilDate', 'Availability range is invalid or too large.');
        }

        $state = $this->availabilityRepository->stateBetween($fromDate, $untilDate);

        return [
            'timezone' => $this->contract->timezone,
            'fromDate' => $fromDate,
            'untilDate' => $untilDate,
            'revision' => $state['revision'],
            'weeklyRules' => array_map(
                $this->weeklyRulePayload(...),
                $state['weeklyRules'],
            ),
            'exceptions' => array_map(
                $this->exceptionPayload(...),
                $state['exceptions'],
            ),
        ];
    }

    /**
     * ESZ-063 — replaces the complete weekly schedule.
     *
     * Every submitted rule is constructed, and therefore validated, before the
     * repository is called at all: a malformed weekday, an inverted window or an
     * impossible validity range raises here, with nothing written. The repository
     * then re-checks the set for overlaps and performs the delete-and-reinsert
     * inside the transaction holding the global availability revision, so there
     * is no ordering of failures that can leave half a week behind.
     *
     * The response is read back from storage rather than echoed from the request.
     * That is what lets the editor adopt server state instead of its own: the ids
     * are new, and the ordering is the repository's.
     *
     * @return array<string, mixed>
     */
    public function adminReplaceWeeklyAvailability(array $request): array
    {
        $expectedRevision = self::requiredInt($request, 'expectedRevision');
        $submitted = $request['rules'] ?? null;
        if (!\is_array($submitted)) {
            throw new BookingValidationException('rules', 'Weekly rule list is required.');
        }

        $rules = [];
        foreach ($submitted as $row) {
            if (!\is_array($row)) {
                throw new BookingValidationException('rules', 'Weekly rule list is malformed.');
            }

            /** @var array<string, mixed> $row */
            $rules[] = new WeeklyAvailabilityRule(
                // The id is assigned by the insert. Nothing the caller sends can
                // name a row, because the whole set is being replaced.
                0,
                self::requiredInt($row, 'weekdayIso'),
                AvailabilityWindow::create(
                    self::requiredString($row, 'startLocal'),
                    self::requiredString($row, 'endLocal'),
                    self::nullableString($row, 'foldUtcOffset'),
                    $this->contract,
                ),
                self::nullableString($row, 'validFrom'),
                self::nullableString($row, 'validUntil'),
                self::requiredBool($row, 'isActive'),
            );
        }

        $stored = $this->availabilityRepository->replaceWeeklyRulesWithRevision($rules, $expectedRevision);

        return [
            'timezone' => $this->contract->timezone,
            'revision' => $stored['revision'],
            'weeklyRules' => array_map(
                $this->weeklyRulePayload(...),
                $stored['value'],
            ),
        ];
    }

    /**
     * ESZ-064 — closures, exceptional openings and removals.
     *
     * `close` and `open` both go through the repository's replacing put, which
     * converts every window boundary with the Europe/Paris IANA rules before
     * storing it: a spring-forward gap is refused and an autumn overlap needs the
     * explicit fold offset. `remove` deletes the row, and deleting it is the
     * whole of restoring the weekly behaviour, because the two were never merged.
     *
     * @return array<string, mixed>
     */
    public function adminMutateAvailabilityException(array $request): array
    {
        $action = self::requiredString($request, 'action');
        $localDate = self::requiredString($request, 'localDate');
        $expectedRevision = self::requiredInt($request, 'expectedRevision');

        if ($action === 'remove') {
            $stored = $this->availabilityRepository->deleteExceptionWithRevision($localDate, $expectedRevision);

            return ['revision' => $stored['revision'], 'exception' => null];
        }

        $stored = match ($action) {
            'close' => $this->availabilityRepository->putClosedExceptionWithRevision(
                $localDate,
                self::nullableString($request, 'note'),
                $expectedRevision,
            ),
            'open' => $this->availabilityRepository->putOpenExceptionWithRevision(
                $localDate,
                $this->submittedWindows($request),
                self::nullableString($request, 'note'),
                $expectedRevision,
            ),
            default => throw new BookingValidationException(
                'action',
                'Unknown availability exception action.',
            ),
        };

        return [
            'revision' => $stored['revision'],
            'exception' => $this->exceptionPayload($stored['value']),
        ];
    }

    /**
     * @param array<string, mixed> $request
     * @return list<AvailabilityWindow>
     */
    private function submittedWindows(array $request): array
    {
        $submitted = $request['windows'] ?? null;
        if (!\is_array($submitted)) {
            throw new BookingValidationException('windows', 'Window list is required.');
        }

        $windows = [];
        foreach ($submitted as $row) {
            if (!\is_array($row)) {
                throw new BookingValidationException('windows', 'Window list is malformed.');
            }

            /** @var array<string, mixed> $row */
            $windows[] = AvailabilityWindow::create(
                self::requiredString($row, 'startLocal'),
                self::requiredString($row, 'endLocal'),
                self::nullableString($row, 'foldUtcOffset'),
                $this->contract,
            );
        }

        return $windows;
    }

    /** @return array<string, mixed> */
    private function summaryEntry(Booking $booking, \DateTimeZone $zone): array
    {
        $start = self::databaseInstant($booking->startsAtUtc);
        $local = $start->setTimezone($zone);

        return [
            'reference' => $booking->reference,
            'serviceKey' => $booking->serviceKey,
            'startsAtUtc' => IsoTimestamp::format($start),
            'endsAtUtc' => IsoTimestamp::format(self::databaseInstant($booking->endsAtUtc)),
            'localDate' => $local->format('Y-m-d'),
            'localStart' => $local->format('H:i'),
            'customerName' => $booking->customerName,
        ];
    }

    /** @return array<string, mixed> */
    private function weeklyRulePayload(WeeklyAvailabilityRule $rule): array
    {
        return [
            'id' => $rule->id,
            'weekdayIso' => $rule->weekdayIso,
            'startLocal' => self::minutePrecision($rule->window->startLocal),
            'endLocal' => self::minutePrecision($rule->window->endLocal),
            'foldUtcOffset' => $rule->window->foldUtcOffset,
            'validFrom' => $rule->validFrom,
            'validUntil' => $rule->validUntil,
            'isActive' => $rule->isActive,
        ];
    }

    /** @return array<string, mixed> */
    private function exceptionPayload(AvailabilityException $exception): array
    {
        return [
            'id' => $exception->id,
            'localDate' => $exception->localDate,
            'kind' => $exception->kind,
            'windows' => array_map(
                static fn (AvailabilityWindow $window): array => [
                    'startLocal' => self::minutePrecision($window->startLocal),
                    'endLocal' => self::minutePrecision($window->endLocal),
                    'foldUtcOffset' => $window->foldUtcOffset,
                ],
                $exception->windows,
            ),
            'note' => $exception->note,
        ];
    }

    /**
     * Availability is stored at one-minute precision as a MySQL TIME, which reads
     * back as `HH:MM:SS`. The contract's wire format is `HH:MM`, so the seconds —
     * which the domain already guarantees are zero — are dropped here rather than
     * left for each consumer to trim.
     */
    private static function minutePrecision(string $localTime): string
    {
        return substr($localTime, 0, 5);
    }

    /** @param array<string, mixed> $request */
    private function updateCustomer(string $reference, array $request): Booking
    {
        return $this->database->transactional(function () use ($reference, $request): Booking {
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            $updated = $this->bookings->updateCustomer(
                $booking,
                self::requiredString($request, 'customerName'),
                self::requiredString($request, 'customerEmail'),
                self::nullableString($request, 'customerPhone'),
                self::nullableString($request, 'customerNote'),
            );
            if (
                $booking->customerName !== $updated->customerName
                || $booking->customerEmail !== $updated->customerEmail
                || $booking->customerPhone !== $updated->customerPhone
                || $booking->customerNote !== $updated->customerNote
            ) {
                $this->history->append($booking->id, 'customer_updated', 'admin', [
                    'fields' => self::changedCustomerFields($booking, $updated),
                ]);
            }

            return $updated;
        });
    }

    private function move(string $reference, \DateTimeImmutable $requestedStart): Booking
    {
        $localDate = $requestedStart->setTimezone(new \DateTimeZone($this->contract->timezone))->format('Y-m-d');
        $this->assertPublicRange($localDate, $localDate);

        return $this->database->transactional(function () use ($reference, $requestedStart, $localDate): Booking {
            $this->lockResource();
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            if ($booking->state->value !== 'confirmed') {
                throw new InvalidBookingTransitionException($booking->state->value, 'moved');
            }
            if ($booking->startsAtUtc === $this->time->databaseUtc($requestedStart)) {
                throw new BookingValidationException('startsAtUtc', 'Booking already starts at that instant.');
            }
            $service = $this->activeService($booking->serviceKey);
            $slot = $this->requestedSlot($service, $localDate, $requestedStart, $reference);
            $updated = $this->bookings->move($booking, $slot->startsAtUtc, $slot->endsAtUtc);
            $this->history->append($booking->id, 'moved', 'admin', [
                'from' => IsoTimestamp::format(self::databaseInstant($booking->startsAtUtc)),
                'to' => IsoTimestamp::format($slot->startsAtUtc),
            ]);
            $this->notifications->moved($booking, $updated);

            return $updated;
        });
    }

    private function cancel(string $reference, ?string $reason): Booking
    {
        return $this->database->transactional(function () use ($reference, $reason): Booking {
            $this->lockResource();
            $booking = $this->bookings->findForUpdate($reference);
            if ($booking === null) {
                throw new BookingNotFoundException($reference);
            }
            $cancelled = $this->bookings->transition($reference, 'cancelled', $reason);
            $this->history->append($booking->id, 'cancelled', 'admin');
            $this->notifications->cancelled($cancelled);

            return $cancelled;
        });
    }

    private function requestedSlot(
        BookableService $service,
        string $localDate,
        \DateTimeImmutable $requestedStart,
        ?string $excludeReference = null,
    ): Slot {
        foreach ($this->compute($service, $localDate, $localDate, $excludeReference) as $slot) {
            if (IsoTimestamp::format($slot->startsAtUtc) === IsoTimestamp::format($requestedStart)) {
                return $slot;
            }
        }

        throw new SlotUnavailableException('Requested slot failed transactional revalidation.');
    }

    /** @return list<Slot> */
    private function compute(
        BookableService $service,
        string $fromDate,
        string $untilDate,
        ?string $excludeReference = null,
    ): array {
        [$fromUtc, $untilUtc] = $this->utcRange($fromDate, $untilDate);

        return $this->slots->generate(
            $service,
            $fromDate,
            $untilDate,
            $this->availabilityRepository->weeklyRules(),
            $this->availabilityRepository->exceptionsBetween($fromDate, $untilDate),
            $this->bookings->occupiedBetween($fromUtc, $untilUtc, $excludeReference),
        );
    }

    /** @return array{\DateTimeImmutable, \DateTimeImmutable} */
    private function utcRange(string $fromDate, string $untilDate): array
    {
        $from = $this->time->localToUtcWithFoldOffset($fromDate . ' 00:00:00', null);
        $after = self::date($untilDate, 'untilDate')->modify('+1 day')->format('Y-m-d');
        $until = $this->time->localToUtcWithFoldOffset($after . ' 00:00:00', null);

        return [$from, $until];
    }

    private function activeService(string $key): BookableService
    {
        $service = $this->services->find($key);
        if ($service === null || !$service->isActive) {
            throw new BookingValidationException('serviceKey', 'Service is not actively bookable.');
        }

        return $service;
    }

    private function assertPublicRange(string $fromDate, string $untilDate): void
    {
        self::date($fromDate, 'fromDate');
        self::date($untilDate, 'untilDate');
        $today = $this->clock->now()
            ->setTimezone(new \DateTimeZone($this->contract->timezone))
            ->format('Y-m-d');
        $last = self::date($today, 'today')
            ->modify('+' . ($this->contract->slotMaxHorizonDays - 1) . ' days')
            ->format('Y-m-d');
        if ($untilDate < $fromDate || $fromDate < $today || $untilDate > $last) {
            throw new BookingValidationException('dateRange', 'Public booking range is outside the horizon.');
        }
    }

    private function lockResource(): void
    {
        $row = $this->database->fetchOne(
            "SELECT resource_key FROM booking_resource_locks WHERE resource_key = 'primary' FOR UPDATE",
        );
        if (($row['resource_key'] ?? null) !== 'primary') {
            throw new \RuntimeException('The booking serialization row is missing.');
        }
    }

    /** @return array<string, mixed> */
    private function slotPayload(Slot $slot): array
    {
        return [
            'localDate' => $slot->localDate,
            'localStart' => $slot->localStart,
            'foldUtcOffset' => $slot->foldUtcOffset,
            'startsAtUtc' => IsoTimestamp::format($slot->startsAtUtc),
            'endsAtUtc' => IsoTimestamp::format($slot->endsAtUtc),
        ];
    }

    /** @return array<string, mixed> */
    private function publicBookingPayload(Booking $booking): array
    {
        return [
            'reference' => $booking->reference,
            'serviceKey' => $booking->serviceKey,
            'state' => $booking->state->value,
            'startsAtUtc' => IsoTimestamp::format(self::databaseInstant($booking->startsAtUtc)),
            'endsAtUtc' => IsoTimestamp::format(self::databaseInstant($booking->endsAtUtc)),
        ];
    }

    /** @return array<string, mixed> */
    private function adminBookingPayload(Booking $booking): array
    {
        return [
            ...$this->publicBookingPayload($booking),
            'timezone' => $booking->timezoneName,
            'customerName' => $booking->customerName,
            'customerEmail' => $booking->customerEmail,
            'customerPhone' => $booking->customerPhone,
            'customerNote' => $booking->customerNote,
            'consentAtUtc' => IsoTimestamp::format(self::databaseInstant($booking->consentAtUtc)),
            'cancelledAtUtc' => $booking->cancelledAtUtc === null
                ? null
                : IsoTimestamp::format(self::databaseInstant($booking->cancelledAtUtc)),
            'cancellationReason' => $booking->cancellationReason,
            'createdAt' => $booking->createdAt,
            'updatedAt' => $booking->updatedAt,
            'history' => array_map(static fn (BookingHistoryEvent $event): array => [
                'type' => $event->type,
                'actor' => $event->actor,
                'occurredAt' => $event->occurredAt,
            ], $this->history->forBooking($booking->id)),
        ];
    }

    /** @return list<string> */
    private static function changedCustomerFields(Booking $before, Booking $after): array
    {
        $changed = [];
        foreach (
            [
                'customerName' => [$before->customerName, $after->customerName],
                'customerEmail' => [$before->customerEmail, $after->customerEmail],
                'customerPhone' => [$before->customerPhone, $after->customerPhone],
                'customerNote' => [$before->customerNote, $after->customerNote],
            ] as $field => [$old, $new]
        ) {
            if ($old !== $new) {
                $changed[] = $field;
            }
        }

        return $changed;
    }

    /** @param array<string, mixed> $request */
    private static function requiredString(array $request, string $field): string
    {
        $value = $request[$field] ?? null;
        if (!\is_string($value)) {
            throw new BookingValidationException($field, 'Required string is missing.');
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    private static function requiredInt(array $request, string $field): int
    {
        $value = $request[$field] ?? null;
        if (!\is_int($value)) {
            throw new BookingValidationException($field, 'Required integer is missing.');
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    private static function requiredBool(array $request, string $field): bool
    {
        $value = $request[$field] ?? null;
        if (!\is_bool($value)) {
            throw new BookingValidationException($field, 'Required boolean is missing.');
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    private static function nullableString(array $request, string $field): ?string
    {
        $value = $request[$field] ?? null;
        if ($value !== null && !\is_string($value)) {
            throw new BookingValidationException($field, 'Nullable string is malformed.');
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    private static function timestamp(array $request, string $field): \DateTimeImmutable
    {
        $value = self::requiredString($request, $field);
        if (!IsoTimestamp::isCanonical($value)) {
            throw new BookingValidationException($field, 'Timestamp is not canonical UTC.');
        }

        $instant = \DateTimeImmutable::createFromFormat(IsoTimestamp::FORMAT, $value, new \DateTimeZone('UTC'));
        if ($instant === false) {
            throw new BookingValidationException($field, 'Timestamp could not be parsed.');
        }

        return $instant;
    }

    private static function date(string $value, string $field): \DateTimeImmutable
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d') !== $value) {
            throw new BookingValidationException($field, 'Date must be a real YYYY-MM-DD value.');
        }

        return $date;
    }

    private static function databaseInstant(string $value): \DateTimeImmutable
    {
        return new \DateTimeImmutable($value, new \DateTimeZone('UTC'));
    }
}
