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
use Eszter\Contract\ContractArtifacts;
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

    // --- ESZ-142: the immutable consent-notice catalog ---------------------

    public function testTheConsentNoticeCatalogIsParsedFromTheArtifact(): void
    {
        self::assertSame(['booking-consent-v1'], $this->contract->consentNoticeIds);
        self::assertSame('booking-consent-v1', $this->contract->currentConsentNoticeId);
        self::assertSame('^[a-z0-9][a-z0-9_-]{0,63}$', $this->contract->consentNoticeIdPattern);

        self::assertTrue($this->contract->acceptsConsentNoticeId('booking-consent-v1'));
        self::assertFalse($this->contract->acceptsConsentNoticeId('booking-consent-9999'));
        // Shape is part of acceptance: an id the wire enum can never produce
        // (uppercase, spaces, text) is not accepted at the domain layer either.
        self::assertFalse($this->contract->acceptsConsentNoticeId('Booking-Consent-V1'));
        self::assertFalse($this->contract->acceptsConsentNoticeId('j\'accepte…'));
    }

    /**
     * ESZ-142, proofs 4 and 7 — the reader over a future catalog version.
     *
     * A future wording change appends an entry and moves the current pointer
     * (here `booking-consent-v2`), exactly as the catalog policy documents.
     * The reader then reports the new current id while still accepting the
     * old one: acceptance is membership of the immutable catalog, so a
     * historical stored id is never silently remapped — the pointer move
     * changes what new clients send, not what old ids mean.
     */
    public function testAMovedCurrentPointerNeverRejectsOrRemapsAHistoricalId(): void
    {
        $directory = TestEnvironment::makeTempDirectory('eszter-consent-future');
        $checksum = null;

        try {
            $source = TestEnvironment::contractsDirectory() . '/booking-domain.json';
            /** @var array<mixed> $document */
            $document = json_decode((string) file_get_contents($source), true, 512, JSON_THROW_ON_ERROR);
            /** @var array<string, mixed> $consentNotices */
            $consentNotices = $document['consentNotices'];
            /** @var list<array{id: string, text: string}> $entries */
            $entries = $consentNotices['entries'];
            $entries[] = [
                'id' => 'booking-consent-v2',
                'text' => 'J’accepte que mes coordonnées soient utilisées pour '
                    . 'traiter cette demande de rendez-vous (version 2).',
            ];
            $consentNotices['entries'] = $entries;
            $consentNotices['currentId'] = 'booking-consent-v2';
            $document['consentNotices'] = $consentNotices;
            $flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
            $rewritten = json_encode($document, $flags) . "\n";
            $checksum = hash('sha256', $rewritten);
            file_put_contents($directory . '/booking-domain.json', $rewritten);
            file_put_contents(
                $directory . '/manifest.json',
                json_encode([
                    'artifacts' => [['file' => 'booking-domain.json', 'sha256' => $checksum]],
                ], JSON_PRETTY_PRINT) . "\n",
            );

            $future = BookingDomainContract::fromArtifacts(new ContractArtifacts($directory));

            // The pointer moved…
            self::assertSame('booking-consent-v2', $future->currentConsentNoticeId);
            self::assertSame(
                ['booking-consent-v1', 'booking-consent-v2'],
                $future->consentNoticeIds,
            );
            // …but the historical id is accepted unchanged — membership is
            // the only rule, and no id is ever remapped onto the new notice.
            self::assertTrue($future->acceptsConsentNoticeId('booking-consent-v1'));
            self::assertTrue($future->acceptsConsentNoticeId('booking-consent-v2'));
            self::assertFalse($future->acceptsConsentNoticeId('booking-consent-9999'));
        } finally {
            TestEnvironment::removeDirectory($directory);
        }
    }
}
