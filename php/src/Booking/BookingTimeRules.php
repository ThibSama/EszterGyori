<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * The administrator's booking-time rules (ESZ-151).
 *
 * Three values, one `system_settings` row: the minimum lead before a slot may
 * start, the preferred usual finish (a local wall time, or null for "the
 * window's end") and the maximum overrun an appointment's own end may run
 * past that finish. They only ever narrow what the weekly rules and date
 * exceptions already allow — {@see SlotEngine} applies them, and nothing
 * else does. The defaults are the pre-ESZ-151 behaviour: with no lead, no
 * finish and no overrun the engine offers exactly the slots it offered
 * before, minus starts already in the past.
 */
final class BookingTimeRules
{
    private function __construct(
        public readonly int $minimumLeadMinutes,
        /** `HH:MM:SS` Europe/Paris wall time, or null. */
        public readonly ?string $preferredFinishLocal,
        public readonly int $maxOverrunMinutes,
    ) {
    }

    public static function create(
        int $minimumLeadMinutes,
        ?string $preferredFinishLocal,
        int $maxOverrunMinutes,
        BookingDomainContract $contract,
    ): self {
        if ($minimumLeadMinutes < 0 || $minimumLeadMinutes > $contract->minimumLeadMaxMinutes) {
            throw new BookingValidationException(
                'minimumLeadMinutes',
                'Minimum lead time is outside the allowed range.',
            );
        }
        if ($maxOverrunMinutes < 0 || $maxOverrunMinutes > $contract->maxOverrunMaxMinutes) {
            throw new BookingValidationException(
                'maxOverrunMinutes',
                'Maximum overrun is outside the allowed range.',
            );
        }

        return new self(
            $minimumLeadMinutes,
            $preferredFinishLocal === null ? null : self::time($preferredFinishLocal),
            $maxOverrunMinutes,
        );
    }

    /** No lead, no preferred finish, no overrun: nothing narrows until configured. */
    public static function defaults(): self
    {
        return new self(0, null, 0);
    }

    /**
     * The stored JSON shape (`{"minimumLeadMinutes","preferredFinishLocal","maxOverrunMinutes"}`),
     * validated the same way a request is.
     *
     * @param array<mixed> $decoded
     */
    public static function fromStored(array $decoded, BookingDomainContract $contract): self
    {
        $lead = $decoded['minimumLeadMinutes'] ?? null;
        $finish = $decoded['preferredFinishLocal'] ?? null;
        $overrun = $decoded['maxOverrunMinutes'] ?? null;
        if (!\is_int($lead) || !\is_int($overrun) || ($finish !== null && !\is_string($finish))) {
            throw new \RuntimeException('Booking time rules setting is malformed.');
        }

        return self::create($lead, $finish, $overrun, $contract);
    }

    /**
     * The preferred finish as minutes from local civil midnight, the unit the
     * slot grid is aligned on — or null when the window's end is the finish.
     */
    public function preferredFinishMinuteOfDay(): ?int
    {
        if ($this->preferredFinishLocal === null) {
            return null;
        }

        return ((int) substr($this->preferredFinishLocal, 0, 2)) * 60 + (int) substr($this->preferredFinishLocal, 3, 2);
    }

    /** @return array{minimumLeadMinutes: int, preferredFinishLocal: ?string, maxOverrunMinutes: int} */
    public function payload(): array
    {
        return [
            'minimumLeadMinutes' => $this->minimumLeadMinutes,
            // Stored at one-minute precision as `HH:MM:SS`; the wire is `HH:MM`.
            'preferredFinishLocal' => $this->preferredFinishLocal === null
                ? null
                : substr($this->preferredFinishLocal, 0, 5),
            'maxOverrunMinutes' => $this->maxOverrunMinutes,
        ];
    }

    private static function time(string $value): string
    {
        $format = preg_match('/^\d{2}:\d{2}$/D', $value) === 1 ? 'H:i' : 'H:i:s';
        $time = \DateTimeImmutable::createFromFormat('!' . $format, $value, new \DateTimeZone('UTC'));
        if ($time === false || $time->format($format) !== $value || $time->format('s') !== '00') {
            throw new BookingValidationException(
                'preferredFinishLocal',
                'Preferred finish must use HH:MM on a real 24-hour clock.',
            );
        }

        return $time->format('H:i:s');
    }
}
