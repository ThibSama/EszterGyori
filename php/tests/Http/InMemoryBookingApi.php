<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\AvailabilityRevisionConflictException;
use Eszter\Booking\BookableServiceNotFoundException;
use Eszter\Booking\BookableServiceRevisionConflictException;
use Eszter\Booking\BookingApi;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingRequestFields;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\SlotUnavailableException;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Tests\TestEnvironment;

/** Deterministic transport fixture; MySQL behavior is proved by the SQL suite. */
final class InMemoryBookingApi implements BookingApi
{
    private int $availabilityRevision = 0;
    /** @var array{minimumLeadMinutes: int, preferredFinishLocal: ?string, maxOverrunMinutes: int} */
    private array $bookingTimeRules = [
        'minimumLeadMinutes' => 0,
        'preferredFinishLocal' => null,
        'maxOverrunMinutes' => 0,
    ];

    private const REFERENCE = 'bk_00000000000000000000000000000000';

    private readonly BookingDomainContract $contract;

    private readonly BookingTimePolicy $time;

    /**
     * The availability fixtures below deliberately run the *real* domain value
     * objects rather than hard-coding which requests are refused.
     *
     * `AvailabilityWindow`, `WeeklyAvailabilityRule` and `BookingTimePolicy` need
     * no database — they are pure — so a fixture that skipped them would turn the
     * contract's refusal cases into assertions about the fixture. Running them
     * means `weekly.put.invertedWindow`, `weekly.put.overlappingWindows` and
     * `exceptions.patch.nonexistentLocalTime` are refused by the same code the
     * production path uses, and the transport is what is left under test.
     */
    public function __construct()
    {
        $this->contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
        $this->time = new BookingTimePolicy($this->contract);
    }

    /**
     * ESZ-149 — the fixture catalog: one active row and one archived row. The
     * archived one is what proves the admin read lists everything while the
     * public read lists only what can be booked.
     */
    private const SERVICE_UPDATED_AT = '2026-06-01T10:00:00.000Z';

    /** @return array<string, mixed> */
    public function services(): array
    {
        return [
            'services' => [[
                'key' => 'brows',
                'label' => 'Sourcils',
                'description' => 'Poudré ou poil à poil.',
                'durationMinutes' => 30,
                'imageSrc' => null,
            ]],
            // ESZ-150: the fixture deployment is single-service; no
            // combination is validated, so none is offered.
            'maxServicesPerAppointment' => 1,
            'combinations' => [],
        ];
    }

    /** @return array<string, mixed> */
    public function availability(array $request): array
    {
        // ESZ-149: the key shape is structural, membership is the catalog's.
        // The fixture catalog holds exactly one active service, so any other
        // well-formed key is the domain's refusal, not the schema's. ESZ-150:
        // the same parser the domain uses, so `serviceKeys: ["brows"]` is the
        // single service and any multi-key selection has no validated
        // combination here.
        if (BookingRequestFields::serviceKeys($request) !== ['brows']) {
            throw new BookingValidationException('serviceKey', 'Service is not actively bookable.');
        }

        return $this->fixtureAvailability();
    }

    /** @return array<string, mixed> */
    private function fixtureAvailability(): array
    {
        return [
            'serviceKey' => 'brows',
            'serviceKeys' => ['brows'],
            'combinationKey' => null,
            'timezone' => 'Europe/Paris',
            'fromDate' => '2026-06-15',
            'untilDate' => '2026-06-15',
            'slots' => [[
                'localDate' => '2026-06-15',
                'localStart' => '09:00',
                'foldUtcOffset' => null,
                'startsAtUtc' => '2026-06-15T07:00:00.000Z',
                'endsAtUtc' => '2026-06-15T07:30:00.000Z',
            ]],
        ];
    }

    /** @return array<string, mixed> */
    public function create(array $request): array
    {
        if (($request['startsAtUtc'] ?? null) === '2026-06-15T07:15:00.000Z') {
            throw new SlotUnavailableException('fixture stale slot');
        }

        return [
            'reference' => self::REFERENCE,
            'serviceKey' => 'brows',
            'serviceKeys' => ['brows'],
            'combinationKey' => null,
            'state' => 'confirmed',
            'startsAtUtc' => '2026-06-15T07:00:00.000Z',
            'endsAtUtc' => '2026-06-15T07:30:00.000Z',
        ];
    }

    /** @return array<string, mixed> */
    public function adminQuery(array $request): array
    {
        // ESZ-145: the fixture mirrors the split surfaces — a range read is a
        // page of current-state facts, a reference read adds one bounded
        // history page beside the booking.
        if (($request['mode'] ?? null) === 'reference') {
            return [
                'booking' => $this->adminBooking('confirmed', '2026-06-15T07:00:00.000Z'),
                'historyPage' => [
                    'pageSize' => $this->contract->adminHistoryPageSize,
                    'hasMore' => false,
                    'nextCursor' => null,
                    'events' => [[
                        'type' => 'created',
                        'actor' => 'public',
                        'occurredAt' => '2026-06-13T12:00:00.000Z',
                    ]],
                ],
            ];
        }

        return [
            'bookings' => [$this->adminBooking('confirmed', '2026-06-15T07:00:00.000Z')],
            'page' => [
                'pageSize' => $this->contract->adminRangePageSize,
                'hasMore' => false,
                'nextCursor' => null,
            ],
        ];
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMoveAvailability(array $request): array
    {
        // A move read names a booking, not a service key: the fixture answers
        // the same computed window without the public key check.
        return $this->fixtureAvailability();
    }

    /** @return array<string, mixed> */
    public function adminMutate(array $request): array
    {
        $action = $request['action'] ?? null;
        $state = $action === 'cancel' ? 'cancelled' : 'confirmed';
        $start = $action === 'move' ? '2026-06-15T08:00:00.000Z' : '2026-06-15T07:00:00.000Z';

        return ['booking' => $this->adminBooking($state, $start)];
    }

    /** @return array<string, mixed> */
    public function adminServices(): array
    {
        return [
            'services' => [
                $this->adminService('brows', 'Sourcils', 30, 'active'),
                $this->adminService('lashes', 'Cils (ancienne offre)', 45, 'archived'),
            ],
            'maxServicesPerAppointment' => 1,
            // ESZ-150: one stored combination whose member is archived — listed
            // (history must stay nameable) but not bookable.
            'combinations' => [$this->adminCombination('validated', false)],
            'combinationsComplete' => true,
        ];
    }

    /** @return array<string, mixed> */
    public function adminMutateService(array $request): array
    {
        $action = $request['action'] ?? null;

        // ESZ-150: the combination side of the same PATCH.
        if ($action === 'setMaxServices') {
            $max = $request['maxServicesPerAppointment'] ?? null;
            if (!\is_int($max) || $max < 1 || $max > $this->contract->maxServicesPerAppointmentLimit) {
                throw new BookingValidationException('maxServicesPerAppointment', 'Outside the V1 bounds.');
            }

            return ['maxServicesPerAppointment' => $max];
        }
        if ($action === 'validateCombination') {
            $duration = \is_int($request['durationMinutes'] ?? null) ? $request['durationMinutes'] : 75;

            return ['combination' => $this->adminCombination('validated', false, $duration)];
        }
        if ($action === 'disableCombination' || $action === 'enableCombination') {
            $key = \is_string($request['key'] ?? null) ? $request['key'] : '';
            if ($key !== 'brows+lashes') {
                throw new BookableServiceNotFoundException($key);
            }

            return ['combination' => $this->adminCombination(
                $action === 'disableCombination' ? 'disabled' : 'validated',
                false,
            )];
        }

        if ($action === 'create') {
            $label = \is_string($request['label'] ?? null) ? $request['label'] : 'Prestation';
            $duration = \is_int($request['durationMinutes'] ?? null) ? $request['durationMinutes'] : 60;

            return ['service' => $this->adminService('microblading-sourcils', $label, $duration, 'active')];
        }

        $key = \is_string($request['key'] ?? null) ? $request['key'] : '';
        if ($key !== 'brows') {
            throw new BookableServiceNotFoundException($key);
        }
        $expected = \is_string($request['expectedUpdatedAt'] ?? null) ? $request['expectedUpdatedAt'] : '';
        if ($expected !== self::SERVICE_UPDATED_AT) {
            throw new BookableServiceRevisionConflictException($key, $expected, self::SERVICE_UPDATED_AT);
        }

        return ['service' => match ($action) {
            'update' => $this->adminService(
                $key,
                \is_string($request['label'] ?? null) ? $request['label'] : 'Sourcils',
                \is_int($request['durationMinutes'] ?? null) ? $request['durationMinutes'] : 30,
                'active',
                \is_string($request['imageSrc'] ?? null) ? $request['imageSrc'] : null,
            ),
            'archive' => $this->adminService($key, 'Sourcils', 30, 'archived'),
            'restore' => $this->adminService($key, 'Sourcils', 30, 'active'),
            default => throw new BookingValidationException('action', 'Unknown service mutation action.'),
        }];
    }

    /** @return array<string, mixed> */
    private function adminService(
        string $key,
        string $label,
        int $duration,
        string $status,
        ?string $imageSrc = null,
    ): array {
        return [
            'key' => $key,
            'label' => $label,
            'description' => 'Poudré ou poil à poil.',
            'durationMinutes' => $duration,
            'imageSrc' => $imageSrc,
            'status' => $status,
            'createdAt' => '2026-05-01T09:00:00.000Z',
            'updatedAt' => self::SERVICE_UPDATED_AT,
        ];
    }

    /** @return array<string, mixed> */
    private function adminCombination(string $status, bool $bookable, int $duration = 70): array
    {
        return [
            'key' => 'brows+lashes',
            'serviceKeys' => ['brows', 'lashes'],
            'proposedDurationMinutes' => 75,
            'durationMinutes' => $duration,
            'status' => $status,
            'bookable' => $bookable,
            'updatedAt' => self::SERVICE_UPDATED_AT,
        ];
    }

    /** @return array<string, mixed> */
    public function adminSummary(array $request): array
    {
        return [
            'timezone' => 'Europe/Paris',
            'todayDate' => '2026-06-15',
            'untilDate' => '2026-06-21',
            'upcomingDays' => 7,
            'counts' => [
                'todayConfirmed' => 1,
                'todayCancelled' => 1,
                'upcomingConfirmed' => 1,
                'upcomingCancelled' => 0,
            ],
            'nextConfirmedStartsAtUtc' => '2026-06-15T07:00:00.000Z',
            'listings' => [
                'todayComplete' => true,
                'upcomingComplete' => true,
            ],
            'today' => [[
                'reference' => self::REFERENCE,
                'serviceKey' => 'brows',
                'serviceKeys' => ['brows'],
                'startsAtUtc' => '2026-06-15T07:00:00.000Z',
                'endsAtUtc' => '2026-06-15T07:30:00.000Z',
                'localDate' => '2026-06-15',
                'localStart' => '09:00',
                'customerName' => 'Cliente Exemple',
            ]],
            'upcoming' => [[
                'reference' => 'bk_11111111111111111111111111111111',
                'serviceKey' => 'brows',
                'serviceKeys' => ['brows'],
                'startsAtUtc' => '2026-06-17T08:00:00.000Z',
                'endsAtUtc' => '2026-06-17T08:30:00.000Z',
                'localDate' => '2026-06-17',
                'localStart' => '10:00',
                'customerName' => 'Cliente Suivante',
            ]],
        ];
    }

    /** @return array<string, mixed> */
    public function adminAvailability(array $request): array
    {
        return [
            'timezone' => 'Europe/Paris',
            'fromDate' => \is_string($request['fromDate'] ?? null) ? $request['fromDate'] : '2026-06-01',
            'untilDate' => \is_string($request['untilDate'] ?? null) ? $request['untilDate'] : '2026-06-30',
            'revision' => $this->availabilityRevision,
            'weeklyRules' => [[
                'id' => 1,
                'weekdayIso' => 2,
                'startLocal' => '09:00',
                'endLocal' => '12:30',
                'foldUtcOffset' => null,
                'validFrom' => null,
                'validUntil' => null,
                'isActive' => true,
            ]],
            'exceptions' => [[
                'id' => 1,
                'localDate' => '2026-06-15',
                'kind' => 'closed',
                'windows' => [],
                'note' => 'Jour férié',
            ]],
            'bookingTimeRules' => $this->bookingTimeRules,
        ];
    }

    /** @return array<string, mixed> */
    public function adminReplaceWeeklyAvailability(array $request): array
    {
        $this->assertAvailabilityRevision($request);
        $submitted = $request['rules'] ?? null;
        if (!\is_array($submitted)) {
            throw new BookingValidationException('rules', 'Weekly rule list is required.');
        }

        $rules = [];
        $stored = [];
        foreach (array_values($submitted) as $index => $row) {
            if (!\is_array($row)) {
                throw new BookingValidationException('rules', 'Weekly rule list is malformed.');
            }

            /** @var array<string, mixed> $row */
            $rule = new WeeklyAvailabilityRule(
                $index + 1,
                self::integer($row, 'weekdayIso'),
                $this->window($row),
                self::optionalString($row, 'validFrom'),
                self::optionalString($row, 'validUntil'),
                (bool) ($row['isActive'] ?? false),
            );
            $rules[] = $rule;
            $stored[] = [
                'id' => $rule->id,
                'weekdayIso' => $rule->weekdayIso,
                'startLocal' => substr($rule->window->startLocal, 0, 5),
                'endLocal' => substr($rule->window->endLocal, 0, 5),
                'foldUtcOffset' => $rule->window->foldUtcOffset,
                'validFrom' => $rule->validFrom,
                'validUntil' => $rule->validUntil,
                'isActive' => $rule->isActive,
            ];
        }

        self::assertNoOverlap($rules);

        // ESZ-151: the rules ride on the same PUT and are stored with it.
        $timeRules = $request['bookingTimeRules'] ?? null;
        if (\is_array($timeRules)) {
            $lead = $timeRules['minimumLeadMinutes'] ?? null;
            $finish = $timeRules['preferredFinishLocal'] ?? null;
            $overrun = $timeRules['maxOverrunMinutes'] ?? null;
            if (!\is_int($lead) || $lead < 0 || !\is_int($overrun) || $overrun < 0) {
                throw new BookingValidationException('bookingTimeRules', 'Booking time rules are malformed.');
            }
            $this->bookingTimeRules = [
                'minimumLeadMinutes' => $lead,
                'preferredFinishLocal' => \is_string($finish) ? $finish : null,
                'maxOverrunMinutes' => $overrun,
            ];
        }

        ++$this->availabilityRevision;

        return [
            'timezone' => 'Europe/Paris',
            'revision' => $this->availabilityRevision,
            'weeklyRules' => $stored,
            'bookingTimeRules' => $this->bookingTimeRules,
        ];
    }

    /** @return array<string, mixed> */
    public function adminMutateAvailabilityException(array $request): array
    {
        $this->assertAvailabilityRevision($request);
        $action = $request['action'] ?? null;
        $localDate = \is_string($request['localDate'] ?? null) ? $request['localDate'] : '2026-08-15';
        $note = self::optionalString($request, 'note');

        if ($action === 'remove') {
            return ['revision' => ++$this->availabilityRevision, 'exception' => null];
        }

        if ($action === 'close') {
            return ['revision' => ++$this->availabilityRevision, 'exception' => [
                'id' => 1,
                'localDate' => $localDate,
                'kind' => 'closed',
                'windows' => [],
                'note' => $note,
            ]];
        }

        if ($action !== 'open') {
            throw new BookingValidationException('action', 'Unknown availability exception action.');
        }

        $submitted = $request['windows'] ?? null;
        if (!\is_array($submitted) || $submitted === []) {
            throw new BookingValidationException(
                'exceptionWindows',
                'Open exception requires at least one window.',
            );
        }

        $windows = [];
        foreach ($submitted as $row) {
            if (!\is_array($row)) {
                throw new BookingValidationException('windows', 'Window list is malformed.');
            }

            /** @var array<string, mixed> $row */
            $window = $this->window($row);
            // The same conversion the repository performs before storing, so a
            // spring-forward boundary is refused here for the real reason.
            $this->time->localToUtcWithFoldOffset(
                $localDate . ' ' . $window->startLocal,
                $window->foldUtcOffset,
            );
            $this->time->localToUtcWithFoldOffset(
                $localDate . ' ' . $window->endLocal,
                $window->foldUtcOffset,
            );
            $windows[] = [
                'startLocal' => substr($window->startLocal, 0, 5),
                'endLocal' => substr($window->endLocal, 0, 5),
                'foldUtcOffset' => $window->foldUtcOffset,
            ];
        }

        return ['revision' => ++$this->availabilityRevision, 'exception' => [
            'id' => 1,
            'localDate' => $localDate,
            'kind' => 'open',
            'windows' => $windows,
            'note' => $note,
        ]];
    }

    /** @param array<string, mixed> $request */
    private function assertAvailabilityRevision(array $request): void
    {
        $expected = $request['expectedRevision'] ?? null;
        if (!\is_int($expected)) {
            throw new BookingValidationException('expectedRevision', 'Availability revision is required.');
        }
        if ($expected !== $this->availabilityRevision) {
            throw new AvailabilityRevisionConflictException($expected, $this->availabilityRevision);
        }
    }

    /** @param array<string, mixed> $row */
    private function window(array $row): AvailabilityWindow
    {
        return AvailabilityWindow::create(
            \is_string($row['startLocal'] ?? null) ? $row['startLocal'] : '',
            \is_string($row['endLocal'] ?? null) ? $row['endLocal'] : '',
            self::optionalString($row, 'foldUtcOffset'),
            $this->contract,
        );
    }

    /** @param list<WeeklyAvailabilityRule> $rules */
    private static function assertNoOverlap(array $rules): void
    {
        foreach ($rules as $index => $left) {
            foreach (array_slice($rules, $index + 1) as $right) {
                if ($left->weekdayIso !== $right->weekdayIso) {
                    continue;
                }
                $leftFrom = $left->validFrom ?? '0000-01-01';
                $leftUntil = $left->validUntil ?? '9999-12-31';
                $rightFrom = $right->validFrom ?? '0000-01-01';
                $rightUntil = $right->validUntil ?? '9999-12-31';
                if ($leftFrom > $rightUntil || $rightFrom > $leftUntil) {
                    continue;
                }
                if (
                    $left->window->startLocal < $right->window->endLocal
                    && $right->window->startLocal < $left->window->endLocal
                ) {
                    throw new BookingValidationException(
                        'weeklyRules',
                        'Weekly windows overlap for an intersecting validity range.',
                    );
                }
            }
        }
    }

    /** @param array<string, mixed> $row */
    private static function integer(array $row, string $field): int
    {
        $value = $row[$field] ?? null;

        return \is_int($value) ? $value : 0;
    }

    /** @param array<string, mixed> $row */
    private static function optionalString(array $row, string $field): ?string
    {
        $value = $row[$field] ?? null;

        return \is_string($value) ? $value : null;
    }

    /** @return array<string, mixed> */
    private function adminBooking(string $state, string $start): array
    {
        $cancelled = $state === 'cancelled';

        return [
            'reference' => self::REFERENCE,
            'serviceKey' => 'brows',
            'serviceKeys' => ['brows'],
            'combinationKey' => null,
            'state' => $state,
            'startsAtUtc' => $start,
            'endsAtUtc' => $start === '2026-06-15T08:00:00.000Z'
                ? '2026-06-15T08:30:00.000Z'
                : '2026-06-15T07:30:00.000Z',
            'timezone' => 'Europe/Paris',
            'customerName' => 'Cliente Exemple',
            'customerEmail' => 'cliente@example.test',
            'customerPhone' => null,
            'customerNote' => null,
            'consentAtUtc' => '2026-06-13T12:00:00.000Z',
            'cancelledAtUtc' => $cancelled ? '2026-06-13T12:00:00.000Z' : null,
            'cancellationReason' => $cancelled ? 'Indisponible' : null,
            'createdAt' => '2026-06-13T12:00:00.000Z',
            'updatedAt' => '2026-06-13T12:00:00.000Z',
        ];
    }
}
