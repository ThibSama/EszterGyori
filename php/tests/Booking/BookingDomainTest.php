<?php

declare(strict_types=1);

namespace Eszter\Tests\Booking;

use Eszter\Booking\AmbiguousLocalTimeException;
use Eszter\Booking\AvailabilityWindow;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingState;
use Eszter\Booking\BookingStateMachine;
use Eszter\Booking\BookingTimePolicy;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\InvalidBookingTransitionException;
use Eszter\Booking\NonexistentLocalTimeException;
use Eszter\Contract\StructuralValidator;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/** Pure Package 4.1 domain rules: identity, timezone/DST and state transitions. */
final class BookingDomainTest extends TestCase
{
    private BookingDomainContract $contract;
    private BookingTimePolicy $time;
    private BookingStateMachine $states;

    protected function setUp(): void
    {
        $this->contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
        $this->time = new BookingTimePolicy($this->contract);
        $this->states = new BookingStateMachine($this->contract);
    }

    public function testServiceKeysAreTheStableSiteContentIdentifiers(): void
    {
        self::assertSame(['brows', 'eyeliner', 'lips', 'freckles'], $this->contract->serviceKeys);
        self::assertTrue($this->contract->acceptsServiceKey('brows'));
        self::assertFalse($this->contract->acceptsServiceKey('Sourcils'));
        self::assertFalse($this->contract->acceptsServiceKey('../brows'));
    }

    public function testTheV1StateGraphContainsOnlyExplicitCancellation(): void
    {
        self::assertSame(['confirmed', 'cancelled'], $this->contract->states);
        self::assertSame('confirmed', $this->states->initial()->value);

        $confirmed = BookingState::fromString('confirmed', $this->contract);
        $cancelled = BookingState::fromString('cancelled', $this->contract);

        self::assertSame('cancelled', $this->states->transition($confirmed, $cancelled)->value);
    }

    public function testSameStateAndTerminalStateTransitionsFailExplicitly(): void
    {
        $cancelled = BookingState::fromString('cancelled', $this->contract);

        foreach (['cancelled', 'confirmed'] as $target) {
            try {
                $this->states->transition(
                    $cancelled,
                    BookingState::fromString($target, $this->contract),
                );
                self::fail("cancelled -> {$target} was accepted");
            } catch (InvalidBookingTransitionException $exception) {
                self::assertSame('cancelled', $exception->from);
                self::assertSame($target, $exception->to);
            }
        }
    }

    public function testAnUnknownStateIsAValidationError(): void
    {
        $this->expectException(BookingValidationException::class);
        BookingState::fromString('completed', $this->contract);
    }

    /**
     * The civil-time range now lives in the wire type, and this proves it lives
     * there *as well as* in the domain rather than instead of it.
     *
     * The structural half is the generated JSON Schema, which is the same file
     * the endpoints validate against; the domain half is
     * {@see AvailabilityWindow}, which never learned to trust its input. Both
     * are asserted on the same values, because the failure this guards against
     * is someone deleting one of them on the grounds that the other exists.
     */
    public function testCivilTimeRangeIsRefusedStructurallyAndByTheDomain(): void
    {
        $structural = new StructuralValidator(TestEnvironment::artifacts());

        $body = static fn (string $start, string $end): array => [
            'expectedRevision' => 0,
            'rules' => [[
            'weekdayIso' => 2,
            'startLocal' => $start,
            'endLocal' => $end,
            'foldUtcOffset' => null,
            'validFrom' => null,
            'validUntil' => null,
            'isActive' => true,
            ]],
        ];

        self::assertSame(
            [],
            $structural->validate(
                $body('00:00', '23:59'),
                'admin-availability-weekly-replace-request.schema.json',
            ),
            'the two ends of the civil day must remain ordinary values',
        );

        foreach (['24:00', '25:00', '09:60', '99:99', '9:30', '09:00:00'] as $impossible) {
            self::assertNotSame(
                [],
                $structural->validate(
                    $body('09:00', $impossible),
                    'admin-availability-weekly-replace-request.schema.json',
                ),
                "{$impossible} passed structural validation",
            );

            try {
                AvailabilityWindow::create('09:00', $impossible, null, $this->contract);
                self::fail("{$impossible} was accepted by the domain");
            } catch (BookingValidationException) {
                self::addToAssertionCount(1);
            }
        }

        $window = AvailabilityWindow::create('00:00', '23:59', null, $this->contract);
        self::assertSame('00:00:00', $window->startLocal);
        self::assertSame('23:59:00', $window->endLocal);
    }

    public function testOrdinaryParisWallTimeConvertsToUtcWithoutDefaults(): void
    {
        $utc = $this->time->localToUtc('2026-01-15 10:30:00');

        self::assertSame('2026-01-15 09:30:00.000', $this->time->databaseUtc($utc));
        self::assertSame('Europe/Paris', $this->contract->timezone);
    }

    public function testSpringForwardNonexistentTimeIsRejected(): void
    {
        $this->expectException(NonexistentLocalTimeException::class);
        $this->time->localToUtc('2026-03-29 02:30:00');
    }

    public function testFallBackAmbiguityRequiresAndChecksAnOffset(): void
    {
        try {
            $this->time->localToUtc('2026-10-25 02:30:00');
            self::fail('ambiguous wall time was guessed');
        } catch (AmbiguousLocalTimeException) {
            self::addToAssertionCount(1);
        }

        self::assertSame(
            '2026-10-25 00:30:00.000',
            $this->time->databaseUtc($this->time->localToUtc('2026-10-25 02:30:00', '+02:00')),
        );
        self::assertSame(
            '2026-10-25 01:30:00.000',
            $this->time->databaseUtc($this->time->localToUtc('2026-10-25 02:30:00', '+01:00')),
        );

        $this->expectException(BookingValidationException::class);
        $this->time->localToUtc('2026-10-25 02:30:00', '+03:00');
    }
}
