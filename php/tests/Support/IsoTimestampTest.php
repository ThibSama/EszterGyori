<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Support\FrozenClock;
use Eszter\Support\IsoTimestamp;
use Eszter\Support\SystemClock;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class IsoTimestampTest extends TestCase
{
    /** @return iterable<string, array{mixed, bool}> */
    public static function candidates(): iterable
    {
        yield 'canonical UTC millisecond form' => ['2026-06-13T12:00:00.000Z', true];
        yield 'non-zero milliseconds' => ['2025-01-02T03:04:05.678Z', true];
        yield 'numeric offset instead of Z' => ['2026-06-13T14:00:00.000+02:00', false];
        yield 'second precision' => ['2026-06-13T12:00:00Z', false];
        yield 'microsecond precision' => ['2026-06-13T12:00:00.000000Z', false];
        yield 'not a date at all' => ['not-a-date', false];
        yield 'space instead of T' => ['2026-06-13 12:00:00.000Z', false];
        yield 'impossible calendar date' => ['2026-02-30T12:00:00.000Z', false];
        yield 'leap day that exists' => ['2024-02-29T12:00:00.000Z', true];
        yield 'not a string' => [1_760_000_000, false];
        yield 'null' => [null, false];
        yield 'empty' => ['', false];
    }

    #[DataProvider('candidates')]
    public function testIsCanonical(mixed $value, bool $expected): void
    {
        self::assertSame($expected, IsoTimestamp::isCanonical($value));
    }

    public function testTheSystemClockOnlyEmitsCanonicalTimestamps(): void
    {
        self::assertTrue(IsoTimestamp::isCanonical((new SystemClock())->nowIso()));
    }

    public function testAFrozenClockReturnsExactlyWhatItWasGiven(): void
    {
        self::assertSame('2026-06-13T12:00:00.000Z', (new FrozenClock('2026-06-13T12:00:00.000Z'))->nowIso());
    }

    public function testAFrozenClockRefusesANonCanonicalInstant(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        new FrozenClock('2026-06-13T12:00:00Z');
    }
}
