<?php

declare(strict_types=1);

namespace Eszter\Tests\Booking;

use Eszter\Booking\AmbiguousLocalTimeException;
use Eszter\Booking\AvailabilityException;
use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\BookableService;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingTimeRules;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\OccupiedInterval;
use Eszter\Booking\SlotEngine;
use Eszter\Booking\SlotLimitExceededException;
use Eszter\Booking\WeeklyAvailabilityRule;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/** Pure ESZ-043/044/045 rule, precedence, grid, buffer and DST coverage. */
final class AvailabilitySlotEngineTest extends TestCase
{
    private BookingDomainContract $contract;
    private SlotEngine $engine;

    protected function setUp(): void
    {
        $this->contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
        $this->engine = new SlotEngine($this->contract, new BookingTimePolicy($this->contract));
    }

    public function testMultipleWeeklyWindowsAndInclusiveValidityAreAppliedInOrder(): void
    {
        $rules = [
            $this->rule(1, '14:00', '15:00', '2026-07-06', '2026-07-06'),
            $this->rule(1, '09:00', '10:00'),
            $this->rule(1, '16:00', '17:00', '2026-07-07', null),
        ];

        $slots = $this->engine->generate(
            $this->service(30),
            '2026-07-06',
            '2026-07-06',
            $rules,
            [],
            [],
        );

        self::assertSame(
            ['09:00', '09:15', '09:30', '14:00', '14:15', '14:30'],
            array_column($slots, 'localStart'),
        );
    }

    public function testClosedAndOpenExceptionsReplaceRatherThanMergeWeeklyWindows(): void
    {
        $weekly = [$this->rule(1, '09:00', '17:00')];
        $closed = new AvailabilityException(1, '2026-07-06', 'closed', [], null);
        self::assertSame([], $this->engine->generate(
            $this->service(30),
            '2026-07-06',
            '2026-07-06',
            $weekly,
            [$closed],
            [],
        ));

        $open = new AvailabilityException(2, '2026-07-06', 'open', [
            $this->window('10:00', '11:00'),
            $this->window('14:00', '15:00'),
        ], null);
        $starts = array_column($this->engine->generate(
            $this->service(30),
            '2026-07-06',
            '2026-07-06',
            $weekly,
            [$open],
            [],
        ), 'localStart');

        self::assertSame(['10:00', '10:15', '10:30', '14:00', '14:15', '14:30'], $starts);
        self::assertNotContains('09:00', $starts);
    }

    public function testMidnightGridBuffersAndTouchingOccupancyBoundariesAreDeterministic(): void
    {
        $buffered = $this->engine->generate(
            $this->service(30, 15, 15),
            '2026-07-06',
            '2026-07-06',
            [$this->rule(1, '09:00', '10:00')],
            [],
            [],
        );
        self::assertSame(['09:15'], array_column($buffered, 'localStart'));

        $occupied = [new OccupiedInterval(
            new \DateTimeImmutable('2026-07-06T07:45:00Z'),
            new \DateTimeImmutable('2026-07-06T08:15:00Z'),
        )];
        $starts = array_column($this->engine->generate(
            $this->service(30),
            '2026-07-06',
            '2026-07-06',
            [$this->rule(1, '09:07', '11:00')],
            [],
            $occupied,
        ), 'localStart');

        self::assertSame(['09:15', '10:15', '10:30'], $starts);
    }

    public function testEmptyDayInvalidRangesAndTheHorizonAreExplicit(): void
    {
        self::assertSame([], $this->engine->generate(
            $this->service(30),
            '2026-07-07',
            '2026-07-07',
            [$this->rule(1, '09:00', '10:00')],
            [],
            [],
        ));

        try {
            $this->engine->generate($this->service(30), '2026-07-07', '2026-07-06', [], [], []);
            self::fail('Inverted range was accepted.');
        } catch (BookingValidationException $exception) {
            self::assertSame('untilDate', $exception->field);
        }

        $this->expectException(BookingValidationException::class);
        $this->engine->generate($this->service(30), '2026-01-01', '2026-04-01', [], [], []);
    }

    public function testInactiveServicesCannotProduceSlots(): void
    {
        $service = new BookableService('brows', 'Sourcils', '', null, 30, 0, 0, false, 'now', 'now');

        $this->expectException(BookingValidationException::class);
        $this->engine->generate(
            $service,
            '2026-07-06',
            '2026-07-06',
            [$this->rule(1, '09:00', '10:00')],
            [],
            [],
        );
    }

    public function testResultCountIsBoundedRatherThanSilentlyTruncated(): void
    {
        $rules = [];
        foreach (range(1, 7) as $weekday) {
            $rules[] = $this->rule($weekday, '00:00', '23:59');
        }

        $this->expectException(SlotLimitExceededException::class);
        $this->engine->generate($this->service(5), '2026-01-01', '2026-01-12', $rules, [], []);
    }

    public function testSpringGapCandidatesAreOmittedWithoutChangingTheGrid(): void
    {
        $slots = $this->engine->generate(
            $this->service(15),
            '2026-03-29',
            '2026-03-29',
            [$this->rule(7, '01:00', '04:00')],
            [],
            [],
        );

        self::assertSame(
            ['01:00', '01:15', '01:30', '01:45', '03:00', '03:15', '03:30', '03:45'],
            array_column($slots, 'localStart'),
        );
    }

    public function testFallFoldRequiresAndUsesTheWindowExplicitOffset(): void
    {
        try {
            $this->engine->generate(
                $this->service(15),
                '2026-10-25',
                '2026-10-25',
                [$this->rule(7, '01:00', '04:00')],
                [],
                [],
            );
            self::fail('Ambiguous fold was guessed.');
        } catch (AmbiguousLocalTimeException) {
            self::addToAssertionCount(1);
        }

        $slots = $this->engine->generate(
            $this->service(15),
            '2026-10-25',
            '2026-10-25',
            [$this->rule(7, '01:00', '04:00', null, null, '+02:00')],
            [],
            [],
        );
        $foldSlot = array_values(array_filter(
            $slots,
            static fn ($slot): bool => $slot->localStart === '02:00',
        ));

        self::assertCount(1, $foldSlot);
        self::assertSame('2026-10-25 00:00:00', $foldSlot[0]->startsAtUtc->format('Y-m-d H:i:s'));
    }

    /**
     * ESZ-151 — lead time, preferred finish and overrun, on a 09:00–18:00
     * Monday (2026-07-06, UTC+2) with a 60-minute service.
     */
    public function testLeadTimeFinishAndOverrunNarrowTheWindowWithoutWideningIt(): void
    {
        $weekly = [$this->rule(1, '09:00', '18:00')];
        // 10:00 local; a 60-minute lead makes 11:00 the first offerable start.
        $now = new \DateTimeImmutable('2026-07-06T08:00:00Z');
        $rules = BookingTimeRules::create(60, '17:30', 30, $this->contract);

        $starts = array_column(
            $this->engine->generate($this->service(60), '2026-07-06', '2026-07-06', $weekly, [], [], $now, $rules),
            'localStart',
        );

        // Lead: exactly now + lead is offered, one grid step earlier is not.
        self::assertSame('11:00', $starts[0]);
        self::assertNotContains('10:45', $starts);
        // Finish 17:30 + overrun 30: the end may reach 18:00 (start 17:00) but
        // not 18:15 (start 17:15), and nothing starts at or after 17:30.
        self::assertContains('17:00', $starts);
        self::assertNotContains('17:15', $starts);
        self::assertNotContains('17:30', $starts);

        // A short service still never starts at the finish boundary, even
        // though it would end inside the overrun.
        $short = array_column(
            $this->engine->generate($this->service(15), '2026-07-06', '2026-07-06', $weekly, [], [], $now, $rules),
            'localStart',
        );
        self::assertSame('17:15', end($short));

        // The window stays authoritative: a shorter exceptional window is not
        // widened by the finish + overrun, so the last end is its own 12:00.
        $open = new AvailabilityException(3, '2026-07-06', 'open', [$this->window('09:00', '12:00')], null);
        $exceptional = array_column(
            $this->engine->generate($this->service(60), '2026-07-06', '2026-07-06', $weekly, [$open], [], $now, $rules),
            'localStart',
        );
        self::assertSame('11:00', end($exceptional));

        // Defaults with a clock: only the past is cut, the fit is unchanged.
        $default = array_column(
            $this->engine->generate(
                $this->service(60),
                '2026-07-06',
                '2026-07-06',
                $weekly,
                [],
                [],
                $now,
                BookingTimeRules::defaults(),
            ),
            'localStart',
        );
        self::assertSame('10:00', $default[0]);
        self::assertSame('17:00', end($default));
    }

    public function testWindowAndRuleValidationRejectsMalformedCombinations(): void
    {
        foreach (
            [
                fn () => $this->window('09:00', '09:00'),
                fn () => $this->window('10:00', '09:00'),
                fn () => $this->rule(0, '09:00', '10:00'),
                fn () => $this->rule(8, '09:00', '10:00'),
                fn () => $this->rule(1, '09:00', '10:00', '2026-07-07', '2026-07-06'),
                fn () => $this->rule(1, '09:00', '10:00', '2026-02-30', null),
            ] as $invalid
        ) {
            try {
                $invalid();
                self::fail('Malformed availability value was accepted.');
            } catch (BookingValidationException) {
                self::addToAssertionCount(1);
            }
        }
    }

    private function window(string $start, string $end, ?string $fold = null): AvailabilityWindow
    {
        return AvailabilityWindow::create($start, $end, $fold, $this->contract);
    }

    private function rule(
        int $weekday,
        string $start,
        string $end,
        ?string $from = null,
        ?string $until = null,
        ?string $fold = null,
    ): WeeklyAvailabilityRule {
        return new WeeklyAvailabilityRule(0, $weekday, $this->window($start, $end, $fold), $from, $until, true);
    }

    private function service(int $duration, int $before = 0, int $after = 0): BookableService
    {
        return new BookableService('brows', 'Sourcils', '', null, $duration, $before, $after, true, 'now', 'now');
    }
}
