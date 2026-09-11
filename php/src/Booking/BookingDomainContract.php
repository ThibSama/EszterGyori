<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;

/**
 * The generated Package 4.1/4.2 booking contract, consumed rather than restated.
 *
 * The timezone and state graph are frozen here. Service keys are not (ESZ-149):
 * the artifact freezes only their *shape* (`services.keyPattern`), and the set
 * of keys is owned by the `booking_services` catalog table — so PHP cannot
 * quietly accept a transition the language-neutral contract does not contain,
 * and it cannot require a contract edit to add a service either.
 */
final class BookingDomainContract
{
    /**
     * @param list<string> $foldOffsets
     * @param list<string> $states
     * @param array<string, list<string>> $transitions
     * @param list<string> $consentNoticeIds
     */
    private function __construct(
        public readonly int $version,
        public readonly string $timezone,
        public readonly string $serviceKeyPattern,
        public readonly int $labelMaxLength,
        public readonly int $descriptionMaxLength,
        public readonly int $durationMinMinutes,
        public readonly int $durationMaxMinutes,
        public readonly int $bufferMaxMinutes,
        /**
         * ESZ-150 — the combination rules: the canonical key shape, the
         * bounds and default of the administrator's "services per
         * appointment" setting, its `system_settings` key and the bound on
         * listed candidate combinations.
         */
        public readonly string $combinationKeyPattern,
        public readonly int $maxServicesPerAppointmentLimit,
        public readonly int $maxServicesPerAppointmentDefault,
        public readonly string $maxServicesSettingKey,
        public readonly int $combinationCandidatesMax,
        public readonly array $foldOffsets,
        public readonly int $slotGridMinutes,
        public readonly int $slotMaxHorizonDays,
        public readonly int $slotMaxResults,
        /**
         * ESZ-151 — the booking-time rules: their `system_settings` key and
         * the technical ceilings of the lead and overrun values.
         */
        public readonly string $timeRulesSettingKey,
        public readonly int $minimumLeadMaxMinutes,
        public readonly int $maxOverrunMaxMinutes,
        public readonly int $adminRangePageSize,
        public readonly int $adminRangeMaxPages,
        public readonly int $adminHistoryPageSize,
        public readonly int $adminSummaryListedEntriesMax,
        public readonly array $states,
        public readonly string $initialState,
        public readonly array $transitions,
        /**
         * ESZ-142 — the immutable consent-notice catalog: every machine id
         * ever issued and the one the shipped frontend currently displays.
         */
        public readonly array $consentNoticeIds,
        public readonly string $currentConsentNoticeId,
        public readonly string $consentNoticeIdPattern,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        $document = $artifacts->load('booking-domain.json');
        $services = self::block($document, 'services');
        $timezone = self::block($document, 'timezone');
        $states = self::block($document, 'states');
        $availability = self::block($document, 'availability');
        $grid = self::block($availability, 'grid');
        $limits = self::block($availability, 'limits');
        $timeRules = self::block($availability, 'bookingTimeRules');
        $dst = self::block($timezone, 'dst');
        $duration = self::block($services, 'durationMinutes');
        $buffer = self::block($services, 'bufferMinutes');
        $combinations = self::block($services, 'combinations');
        $maxPerAppointment = self::block($combinations, 'maxPerAppointment');
        $adminViews = self::block($document, 'adminViews');
        $rangeRead = self::block($adminViews, 'rangeRead');
        $historyPage = self::block($adminViews, 'historyPage');
        $summary = self::block($adminViews, 'summary');
        $consentNotices = self::block($document, 'consentNotices');
        $consentNoticeIds = self::consentNoticeIds($consentNotices);
        $currentConsentNoticeId = self::string($consentNotices, 'currentId');
        if (!\in_array($currentConsentNoticeId, $consentNoticeIds, true)) {
            throw new ContractArtifactException(
                'booking-domain.json consentNotices.currentId does not name a catalog entry.',
            );
        }

        return new self(
            self::positiveInt($document, 'version'),
            self::string($timezone, 'iana'),
            self::string($services, 'keyPattern'),
            self::positiveInt($services, 'labelMaxLength'),
            self::positiveInt($services, 'descriptionMaxLength'),
            self::positiveInt($duration, 'min'),
            self::positiveInt($duration, 'max'),
            self::nonNegativeInt($buffer, 'max'),
            self::string($combinations, 'keyPattern'),
            self::positiveInt($maxPerAppointment, 'max'),
            self::positiveInt($maxPerAppointment, 'default'),
            self::string($maxPerAppointment, 'settingKey'),
            self::positiveInt($combinations, 'candidatesListedMax'),
            self::stringList($dst, 'foldOffsets'),
            self::positiveInt($grid, 'minutes'),
            self::positiveInt($limits, 'maxHorizonDays'),
            self::positiveInt($limits, 'maxResults'),
            self::string($timeRules, 'settingKey'),
            self::positiveInt(self::block($timeRules, 'minimumLeadMinutes'), 'max'),
            self::positiveInt(self::block($timeRules, 'maxOverrunMinutes'), 'max'),
            self::positiveInt($rangeRead, 'pageSize'),
            self::positiveInt($rangeRead, 'maxPages'),
            self::positiveInt($historyPage, 'pageSize'),
            self::positiveInt($summary, 'listedEntriesMax'),
            self::stringList($states, 'values'),
            self::string($states, 'initial'),
            self::transitionMap($states),
            $consentNoticeIds,
            $currentConsentNoticeId,
            self::string($consentNotices, 'idPattern'),
        );
    }

    /**
     * Whether `$key` has the frozen service-key shape. Shape only: whether a
     * well-formed key names an actively bookable service is the catalog's
     * decision ({@see BookingServiceCatalog::requireActive()}), never a
     * contract enum's.
     */
    public function acceptsServiceKey(string $key): bool
    {
        return preg_match('#' . $this->serviceKeyPattern . '#D', $key) === 1;
    }

    /**
     * ESZ-150 — whether `$key` has the frozen combination-key shape (sorted
     * member keys joined with `+`). Shape only; whether it names a validated,
     * bookable combination is the catalog's decision.
     */
    public function acceptsCombinationKey(string $key): bool
    {
        return preg_match('#' . $this->combinationKeyPattern . '#D', $key) === 1;
    }

    public function acceptsState(string $state): bool
    {
        return \in_array($state, $this->states, true);
    }

    /**
     * ESZ-142 — whether the wire may carry `id` as the accepted consent
     * notice. Acceptance is membership of the immutable catalog (plus the
     * bounded-ASCII shape the column CHECK mirrors): an id issued in the past
     * stays accepted unchanged, and moving the current pointer changes what
     * clients send, never what a stored id means.
     */
    public function acceptsConsentNoticeId(string $id): bool
    {
        return \in_array($id, $this->consentNoticeIds, true)
            && preg_match('#' . $this->consentNoticeIdPattern . '#D', $id) === 1;
    }

    /** @return list<string> */
    public function nextStates(string $state): array
    {
        return $this->transitions[$state] ?? [];
    }

    /**
     * @param array<mixed> $source
     * @return array<mixed>
     */
    private static function block(array $source, string $key): array
    {
        $value = $source[$key] ?? null;

        if (!\is_array($value)) {
            throw new ContractArtifactException("booking-domain.json has no `{$key}` block.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function string(array $source, string $key): string
    {
        $value = $source[$key] ?? null;

        if (!\is_string($value) || $value === '') {
            throw new ContractArtifactException("booking-domain.json has no non-empty `{$key}` string.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function positiveInt(array $source, string $key): int
    {
        $value = $source[$key] ?? null;

        if (!\is_int($value) || $value <= 0) {
            throw new ContractArtifactException("booking-domain.json has no positive `{$key}` integer.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function nonNegativeInt(array $source, string $key): int
    {
        $value = $source[$key] ?? null;

        if (!\is_int($value) || $value < 0) {
            throw new ContractArtifactException("booking-domain.json has no non-negative `{$key}` integer.");
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

        if (!\is_array($value) || $value === []) {
            throw new ContractArtifactException("booking-domain.json has no non-empty `{$key}` list.");
        }

        $strings = [];
        foreach ($value as $entry) {
            if (!\is_string($entry) || $entry === '') {
                throw new ContractArtifactException("booking-domain.json has a malformed `{$key}` entry.");
            }
            $strings[] = $entry;
        }

        return $strings;
    }

    /**
     * @param array<mixed> $consentNotices
     * @return list<string>
     */
    private static function consentNoticeIds(array $consentNotices): array
    {
        $value = $consentNotices['entries'] ?? null;

        if (!\is_array($value) || $value === []) {
            throw new ContractArtifactException(
                'booking-domain.json consentNotices has no non-empty `entries` list.',
            );
        }

        $ids = [];
        foreach ($value as $entry) {
            if (!\is_array($entry) || !\is_string($entry['id'] ?? null) || $entry['id'] === '') {
                throw new ContractArtifactException(
                    'booking-domain.json consentNotices has a malformed entry.',
                );
            }
            $ids[] = $entry['id'];
        }

        if (\count(array_unique($ids)) !== \count($ids)) {
            throw new ContractArtifactException(
                'booking-domain.json consentNotices entries must have unique ids.',
            );
        }

        return $ids;
    }

    /**
     * @param array<mixed> $states
     * @return array<string, list<string>>
     */
    private static function transitionMap(array $states): array
    {
        $value = $states['transitions'] ?? null;

        if (!\is_array($value)) {
            throw new ContractArtifactException('booking-domain.json has no state transition map.');
        }

        $map = [];
        foreach ($value as $from => $targets) {
            if (!\is_string($from) || !\is_array($targets)) {
                throw new ContractArtifactException('booking-domain.json has a malformed state transition.');
            }
            $map[$from] = [];
            foreach ($targets as $target) {
                if (!\is_string($target)) {
                    throw new ContractArtifactException('booking-domain.json has a non-string transition target.');
                }
                $map[$from][] = $target;
            }
        }

        return $map;
    }
}
