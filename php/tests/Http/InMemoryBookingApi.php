<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\AvailabilityRevisionConflictException;
use Eszter\Booking\BookableServiceNotFoundException;
use Eszter\Booking\BookableServiceRevisionConflictException;
use Eszter\Booking\BookingApi;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingNotFoundException;
use Eszter\Booking\BookingRequestFields;
use Eszter\Booking\BookingRevisionConflictException;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\PlanningConstraint;
use Eszter\Booking\PlanningConstraintNotFoundException;
use Eszter\Booking\SlotUnavailableException;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Privacy\PrivacyRequestDeadline;
use Eszter\Privacy\PrivacyRequestNotFoundException;
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
            // ESZ-152: one strict blocker and one flexible pause in the window.
            'constraints' => [
                [
                    'id' => 1,
                    'kind' => 'leave',
                    'enforcement' => 'strict',
                    'startDate' => '2026-06-22',
                    'endDate' => '2026-06-26',
                    'startLocal' => null,
                    'endLocal' => null,
                    'foldUtcOffset' => null,
                    'reason' => 'Congés',
                ],
                [
                    'id' => 2,
                    'kind' => 'pause',
                    'enforcement' => 'flexible',
                    'startDate' => '2026-06-16',
                    'endDate' => '2026-06-16',
                    'startLocal' => '12:30',
                    'endLocal' => '13:30',
                    'foldUtcOffset' => null,
                    'reason' => null,
                ],
            ],
        ];
    }

    /**
     * ESZ-152 — the constraint mutation as the conformance runner sees it:
     * the request is validated through the real value object, a strict
     * constraint overlapping the fixture appointment (2026-06-17 10:00–10:30
     * Paris) reports it as a conflict, and id 404 is the one that never exists.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutateAvailabilityConstraint(array $request): array
    {
        $this->assertAvailabilityRevision($request);
        $action = $request['action'] ?? null;
        $id = \is_int($request['id'] ?? null) ? $request['id'] : 0;
        if (($action === 'remove' || $action === 'update') && $id === 404) {
            throw new PlanningConstraintNotFoundException($id);
        }
        if ($action === 'remove') {
            return ['revision' => ++$this->availabilityRevision, 'constraint' => null, 'conflicts' => []];
        }
        if ($action !== 'create' && $action !== 'update') {
            throw new BookingValidationException('action', 'Unknown planning constraint action.');
        }

        $constraint = PlanningConstraint::create(
            $action === 'create' ? 1 : $id,
            \is_string($request['kind'] ?? null) ? $request['kind'] : '',
            \is_string($request['startDate'] ?? null) ? $request['startDate'] : '',
            \is_string($request['endDate'] ?? null) ? $request['endDate'] : '',
            self::optionalString($request, 'startLocal'),
            self::optionalString($request, 'endLocal'),
            self::optionalString($request, 'foldUtcOffset'),
            self::optionalString($request, 'reason'),
            $this->contract,
        );
        $blocked = $constraint->blockingInterval($this->time);
        $fixtureStart = new \DateTimeImmutable('2026-06-17T08:00:00Z');
        $fixtureEnd = new \DateTimeImmutable('2026-06-17T08:30:00Z');
        $conflicts = $blocked !== null && $blocked->startsAtUtc < $fixtureEnd && $fixtureStart < $blocked->endsAtUtc
            ? [[
                'reference' => self::REFERENCE,
                'customerName' => 'Cliente Suivante',
                'startsAtUtc' => '2026-06-17T08:00:00.000Z',
                'endsAtUtc' => '2026-06-17T08:30:00.000Z',
            ]]
            : [];

        return [
            'revision' => ++$this->availabilityRevision,
            'constraint' => [
                'id' => $constraint->id,
                'kind' => $constraint->kind,
                'enforcement' => $constraint->enforcement,
                'startDate' => $constraint->startDate,
                'endDate' => $constraint->endDate,
                'startLocal' => $constraint->window === null ? null : substr($constraint->window->startLocal, 0, 5),
                'endLocal' => $constraint->window === null ? null : substr($constraint->window->endLocal, 0, 5),
                'foldUtcOffset' => $constraint->window?->foldUtcOffset,
                'reason' => $constraint->reason,
            ],
            'conflicts' => $conflicts,
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

    /**
     * ESZ-163 — the fixture register: the legacy-reference booking and the
     * current-shape one from the contract cases are the two stored bookings;
     * every other well-formed reference is unknown. The e-mail read answers
     * the fixture customer's one booking and nothing for any other address —
     * the frozen erased placeholder included, which is what the
     * `erasedPlaceholderNeverMatches` case replays.
     *
     * @return array<string, mixed>
     */
    public function adminPrivacyRequestSearch(array $request): array
    {
        $page = [
            'pageSize' => $this->contract->privacyRequests->searchPageSize,
            'hasMore' => false,
            'nextCursor' => null,
        ];

        if (($request['mode'] ?? null) === 'reference') {
            $reference = \is_string($request['reference'] ?? null) ? $request['reference'] : '';
            if (!\in_array($reference, [self::REFERENCE, 'XG73-UVK9'], true)) {
                throw new BookingNotFoundException($reference);
            }

            return ['matches' => [$this->privacyMatch($reference)], 'page' => $page];
        }

        $email = \is_string($request['email'] ?? null) ? mb_strtolower($request['email']) : '';

        return [
            'matches' => $email === 'cliente@example.test' ? [$this->privacyMatch(self::REFERENCE)] : [],
            'page' => $page,
        ];
    }

    /** @return array<string, mixed> */
    public function adminPrivacyRequests(array $request): array
    {
        if (($request['mode'] ?? null) === 'scope') {
            return $this->privacyScope(\is_int($request['id'] ?? null) ? $request['id'] : 0);
        }

        if (($request['mode'] ?? null) === 'detail') {
            $id = \is_int($request['id'] ?? null) ? $request['id'] : 0;
            if ($id !== 1) {
                throw new PrivacyRequestNotFoundException($id);
            }

            return ['request' => $this->privacyRequest(1, 'access', '2026-06-13', [self::REFERENCE])];
        }

        return [
            'requests' => [
                $this->privacyRequest(2, 'erasure', '2026-06-01', [], 'closed'),
                $this->privacyRequest(1, 'access', '2026-06-13', [self::REFERENCE]),
            ],
            'page' => [
                'pageSize' => $this->contract->privacyRequests->historyPageSize,
                'hasMore' => false,
                'nextCursor' => null,
            ],
        ];
    }

    /** @return array<string, mixed> */
    public function adminRecordPrivacyRequest(array $request): array
    {
        $type = \is_string($request['type'] ?? null) ? $request['type'] : '';
        if (!$this->contract->privacyRequests->acceptsType($type)) {
            throw new BookingValidationException('type', 'Privacy request type is not one of the frozen V1 types.');
        }
        $references = \is_array($request['bookingReferences'] ?? null) ? $request['bookingReferences'] : [];
        foreach ($references as $reference) {
            if (!\is_string($reference) || !\in_array($reference, [self::REFERENCE, 'XG73-UVK9'], true)) {
                throw new BookingNotFoundException(\is_string($reference) ? $reference : '');
            }
        }
        $received = \is_string($request['receivedDate'] ?? null) ? $request['receivedDate'] : '2026-06-13';

        return ['request' => $this->privacyRequest(3, $type, $received, array_values($references))];
    }

    /** @return array<string, mixed> */
    private function privacyMatch(string $reference): array
    {
        return [
            'reference' => $reference,
            'serviceKeys' => ['brows'],
            'state' => 'confirmed',
            'startsAtUtc' => '2026-06-15T07:00:00.000Z',
            'endsAtUtc' => '2026-06-15T07:30:00.000Z',
            'customerName' => 'Cliente Exemple',
        ];
    }

    /**
     * @param list<string> $references
     * @return array<string, mixed>
     */
    private function privacyRequest(
        int $id,
        string $type,
        string $received,
        array $references,
        string $status = 'received',
    ): array {
        $deadline = PrivacyRequestDeadline::from(
            BookingRequestFields::date($received, 'receivedDate'),
            $this->contract->privacyRequests->deadlineMonths,
        );

        return [
            'id' => $id,
            'type' => $type,
            'status' => $status,
            'receivedDate' => $received,
            'deadlineDate' => $deadline->format('Y-m-d'),
            'closedAtUtc' => $status === 'closed' ? '2026-06-10T09:00:00.000Z' : null,
            'bookingReferences' => $references,
            'createdAt' => '2026-06-13T12:00:00.000Z',
            'updatedAt' => '2026-06-13T12:00:00.000Z',
        ];
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
            // ESZ-161: a consent-era fixture — consent instant, no privacy
            // notice — exercising the nullable evidence fields.
            'consentAtUtc' => '2026-06-13T12:00:00.000Z',
            'privacyNoticeId' => null,
            'privacyNoticePresentedAtUtc' => null,
            'cancelledAtUtc' => $cancelled ? '2026-06-13T12:00:00.000Z' : null,
            'cancellationReason' => $cancelled ? 'Indisponible' : null,
            'customerDataErasedAt' => null,
            'processingRestrictedAt' => null,
            'createdAt' => '2026-06-13T12:00:00.000Z',
            'updatedAt' => '2026-06-13T12:00:00.000Z',
        ];
    }

    // --- ESZ-164: the rights fixture ----------------------------------------

    /**
     * The register the action cases act on: one open record per type whose
     * action the corpus exercises, plus one closed restriction whose booking
     * is currently restricted (the lift case). The scope entry is the same
     * booking `adminBooking()` serves, in the state the record needs.
     *
     * @return array<string, mixed>|null
     */
    private function privacyFixture(int $id): ?array
    {
        return match ($id) {
            1 => $this->privacyRequest(1, 'access', '2026-06-13', [self::REFERENCE]),
            2 => $this->privacyRequest(2, 'erasure', '2026-06-13', [self::REFERENCE]),
            4 => $this->privacyRequest(4, 'rectification', '2026-06-13', [self::REFERENCE]),
            5 => $this->privacyRequest(5, 'restriction', '2026-06-13', [self::REFERENCE]),
            6 => $this->privacyRequest(6, 'restriction', '2026-06-01', [self::REFERENCE], 'closed'),
            default => null,
        };
    }

    /**
     * @param array{name: string, email: string, phone: ?string, note: ?string}|null $customer
     * @return array<string, mixed>
     */
    private function scopeBooking(?array $customer, ?string $erasedAt, ?string $restrictedAt): array
    {
        return [
            'reference' => self::REFERENCE,
            'serviceKeys' => ['brows'],
            'state' => 'confirmed',
            'startsAtUtc' => '2026-06-15T07:00:00.000Z',
            'endsAtUtc' => '2026-06-15T07:30:00.000Z',
            'updatedAt' => '2026-06-13T12:00:00.000Z',
            'customerDataErasedAt' => $erasedAt,
            'processingRestrictedAt' => $restrictedAt,
            'customer' => $customer,
        ];
    }

    /** @return array{name: string, email: string, phone: ?string, note: ?string} */
    private static function fixtureCustomer(): array
    {
        return ['name' => 'Cliente Exemple', 'email' => 'cliente@example.test', 'phone' => null, 'note' => null];
    }

    /** @return array<string, mixed> */
    private function privacyScope(int $id): array
    {
        $record = $this->privacyFixture($id) ?? throw new PrivacyRequestNotFoundException($id);
        // Record 6 is the closed restriction whose booking is restricted now.
        $restricted = $id === 6 ? '2026-06-10T09:00:00.000Z' : null;

        return ['request' => $record, 'bookings' => [$this->scopeBooking(self::fixtureCustomer(), null, $restricted)]];
    }

    /** @return array<string, mixed> */
    public function adminExecutePrivacyRequestAction(array $request): array
    {
        $action = \is_string($request['action'] ?? null) ? $request['action'] : '';
        $id = \is_int($request['id'] ?? null) ? $request['id'] : 0;
        $record = $this->privacyFixture($id) ?? throw new PrivacyRequestNotFoundException($id);
        $closed = ['status' => 'closed', 'closedAtUtc' => '2026-06-13T12:00:00.000Z'] + $record;

        switch ($action) {
            case 'export':
                if (!\in_array($record['type'], ['access', 'portability'], true)) {
                    throw new BookingValidationException(
                        'type',
                        'Only an access or portability request is answered by an export.',
                    );
                }
                $format = \is_string($request['format'] ?? null) ? $request['format'] : 'json';
                $document = $this->exportDocument($id, $record);

                return [
                    'request' => $closed,
                    'bookings' => [$this->scopeBooking(self::fixtureCustomer(), null, null)],
                    'export' => [
                        'format' => $format,
                        'fileName' => "export-rgpd-demande-{$id}.{$format}",
                        'document' => $format === 'html'
                            ? '<!doctype html><html lang="fr"><body><h1>Vos données personnelles</h1></body></html>'
                            : $document,
                    ],
                ];
            case 'rectify':
                $entries = \is_array($request['bookings'] ?? null) ? $request['bookings'] : [];
                $customer = self::fixtureCustomer();
                foreach ($entries as $entry) {
                    if (!\is_array($entry)) {
                        throw new BookingValidationException('bookings', 'A rectification entry is malformed.');
                    }
                    if (($entry['reference'] ?? null) !== self::REFERENCE) {
                        throw new BookingValidationException('reference', 'The request does not name this booking.');
                    }
                    if (($entry['expectedUpdatedAt'] ?? null) !== '2026-06-13T12:00:00.000Z') {
                        throw new BookingRevisionConflictException(
                            \is_string($entry['expectedUpdatedAt'] ?? null) ? $entry['expectedUpdatedAt'] : '',
                            '2026-06-13T12:00:00.000Z',
                        );
                    }
                    $customer = [
                        'name' => \is_string($entry['customerName'] ?? null)
                            ? $entry['customerName']
                            : $customer['name'],
                        'email' => \is_string($entry['customerEmail'] ?? null)
                            ? $entry['customerEmail']
                            : $customer['email'],
                        'phone' => \is_string($entry['customerPhone'] ?? null) ? $entry['customerPhone'] : null,
                        'note' => \is_string($entry['customerNote'] ?? null) ? $entry['customerNote'] : null,
                    ];
                }

                return [
                    'request' => $closed,
                    'bookings' => [$this->scopeBooking($customer, null, null)],
                    'export' => null,
                ];
            case 'anonymize':
                return [
                    'request' => $closed,
                    'bookings' => [$this->scopeBooking(null, '2026-06-13T12:00:00.000Z', null)],
                    'export' => null,
                ];
            case 'restrict':
                return [
                    'request' => $closed,
                    'bookings' => [$this->scopeBooking(self::fixtureCustomer(), null, '2026-06-13T12:00:00.000Z')],
                    'export' => null,
                ];
            case 'lift':
                return [
                    'request' => $record,
                    'bookings' => [$this->scopeBooking(self::fixtureCustomer(), null, null)],
                    'export' => null,
                ];
            default:
                throw new BookingValidationException('action', 'Unknown privacy request action.');
        }
    }

    /**
     * @param array<string, mixed> $record
     * @return array<string, mixed>
     */
    private function exportDocument(int $id, array $record): array
    {
        return [
            'format' => 'eszter.privacy-export',
            'version' => 1,
            'generatedAtUtc' => '2026-06-13T12:00:00.000Z',
            'request' => ['id' => $id, 'type' => $record['type'], 'receivedDate' => $record['receivedDate']],
            'information' => [
                'controller' => 'Eszter Gyori',
                'purposes' => ['Organiser le rendez-vous demandé.'],
                'legalBasis' => 'Exécution de la prestation demandée et démarches précontractuelles.',
                'retention' => ['90 jours après la fin ou l’annulation du rendez-vous.'],
                'recipients' => ['Hébergement', 'Envoi des e-mails'],
                'source' => 'La personne elle-même, par le formulaire de réservation.',
                'rights' => ['Accès', 'Rectification', 'Effacement', 'Limitation', 'Portabilité'],
                'contact' => 'contact@esztergyori.com',
            ],
            'bookings' => [
                [
                    'reference' => self::REFERENCE,
                    'anonymised' => false,
                    'appointment' => [
                        'serviceKeys' => ['brows'],
                        'serviceLabels' => ['Sourcils'],
                        'state' => 'confirmed',
                        'startsAtUtc' => '2026-06-15T07:00:00.000Z',
                        'endsAtUtc' => '2026-06-15T07:30:00.000Z',
                        'timezone' => 'Europe/Paris',
                        'createdAt' => '2026-06-13T12:00:00.000Z',
                        'cancelledAtUtc' => null,
                        'cancellationReason' => null,
                    ],
                    'customer' => self::fixtureCustomer(),
                    'basis' => [
                        'kind' => 'privacy_notice',
                        'noticeId' => $this->contract->currentPrivacyNoticeId,
                        'presentedAtUtc' => '2026-06-13T12:00:00.000Z',
                        'text' => 'Responsable du traitement : Eszter Gyori.',
                    ],
                    'history' => [
                        ['type' => 'created', 'actor' => 'public', 'occurredAt' => '2026-06-13T12:00:00.000Z'],
                    ],
                    'notifications' => [[
                        'channel' => 'email',
                        'type' => 'booking_confirmation',
                        'status' => 'sent',
                        'dueAtUtc' => '2026-06-13T12:00:00.000Z',
                        'sentAtUtc' => '2026-06-13T12:00:30.000Z',
                    ]],
                ],
            ],
        ];
    }
}
