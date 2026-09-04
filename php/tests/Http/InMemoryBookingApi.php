<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\AvailabilityRevisionConflictException;
use Eszter\Booking\BookingApi;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\SlotUnavailableException;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Tests\TestEnvironment;

/** Deterministic transport fixture; MySQL behavior is proved by the SQL suite. */
final class InMemoryBookingApi implements BookingApi
{
    private int $availabilityRevision = 0;

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

    /** @return array<string, mixed> */
    public function services(): array
    {
        return ['services' => [[
            'key' => 'brows',
            'label' => 'Sourcils',
            'durationMinutes' => 30,
        ]]];
    }

    /** @return array<string, mixed> */
    public function availability(array $request): array
    {
        return [
            'serviceKey' => 'brows',
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
        return $this->availability($request);
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
                'startsAtUtc' => '2026-06-15T07:00:00.000Z',
                'endsAtUtc' => '2026-06-15T07:30:00.000Z',
                'localDate' => '2026-06-15',
                'localStart' => '09:00',
                'customerName' => 'Cliente Exemple',
            ]],
            'upcoming' => [[
                'reference' => 'bk_11111111111111111111111111111111',
                'serviceKey' => 'brows',
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

        ++$this->availabilityRevision;

        return [
            'timezone' => 'Europe/Paris',
            'revision' => $this->availabilityRevision,
            'weeklyRules' => $stored,
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
