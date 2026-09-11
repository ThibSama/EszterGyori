<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * The back-office side of the service catalog (ESZ-149, ESZ-150).
 *
 * Reads return every row, archived included: an archived service still
 * names historical bookings the calendar must render. Since ESZ-150 the same
 * read carries the configured maximum number of services per appointment
 * and the combinations: every stored one (validated or disabled, whatever
 * its members' state) followed by the *candidates* — the not-yet-stored
 * subsets of two to `max` active services, in catalog order, bounded by the
 * contract with an explicit completeness flag. Each carries the advisory
 * proposal (the plain sum of the current component durations) beside the
 * validated duration, which only an explicit validation ever writes.
 *
 * Mutations are the closed set the contract freezes — create, update,
 * archive, restore, setMaxServices, validateCombination, disableCombination,
 * enableCombination — each delegated to one repository write that owns its
 * transaction, its serialization boundary and its optimistic-concurrency
 * check. Nothing here stores anything of its own, and nothing here deletes.
 *
 * Requests arrive already validated against
 * `admin-service-mutation-request.schema.json`; the repositories re-validate
 * the domain bounds for defence in depth, so a shape the schema admits but
 * the domain refuses is still a `BookingValidationException`.
 */
final class BookingServiceAdministration
{
    public function __construct(
        private readonly BookableServiceRepository $services,
        private readonly ServiceCombinationRepository $combinations,
        private readonly BookingDomainContract $contract,
    ) {
    }

    /** @return array<string, mixed> */
    public function adminServices(): array
    {
        $services = $this->services->all();
        $byKey = [];
        $activeKeys = [];
        foreach ($services as $service) {
            $byKey[$service->key] = $service;
            if ($service->isActive) {
                $activeKeys[$service->key] = true;
            }
        }
        $max = $this->combinations->maxServicesPerAppointment();
        $catalog = new BookingServiceCatalog($this->services, $this->combinations);

        $combinations = [];
        $stored = [];
        foreach ($this->combinations->all() as $combination) {
            $stored[$combination->key] = true;
            $combinations[] = $combination->toAdminPayload(
                self::currentProposal($combination->serviceKeys, $byKey),
                $catalog->isBookable($combination, $activeKeys, $max),
            );
        }

        ['candidates' => $candidates, 'complete' => $complete] = $this->candidates(
            array_keys($activeKeys),
            $max,
            $stored,
            $byKey,
        );

        return [
            'services' => array_map(
                static fn (BookableService $service): array => $service->toAdminPayload(),
                $services,
            ),
            'maxServicesPerAppointment' => $max,
            'combinations' => [...$combinations, ...$candidates],
            'combinationsComplete' => $complete,
        ];
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutateService(array $request): array
    {
        $action = $request['action'] ?? null;

        return match ($action) {
            'create' => ['service' => $this->services->create(
                self::string($request, 'label'),
                self::string($request, 'description'),
                self::int($request, 'durationMinutes'),
                self::optionalString($request, 'imageSrc'),
            )->toAdminPayload()],
            'update' => ['service' => $this->services->update(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
                self::string($request, 'label'),
                self::string($request, 'description'),
                self::int($request, 'durationMinutes'),
                self::optionalString($request, 'imageSrc'),
            )->toAdminPayload()],
            'archive' => ['service' => $this->services->setActive(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
                false,
            )->toAdminPayload()],
            'restore' => ['service' => $this->services->setActive(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
                true,
            )->toAdminPayload()],
            'setMaxServices' => [
                'maxServicesPerAppointment' => $this->combinations->setMaxServicesPerAppointment(
                    self::int($request, 'maxServicesPerAppointment'),
                ),
            ],
            'validateCombination' => $this->combinationPayload($this->combinations->validate(
                self::stringList($request, 'serviceKeys'),
                self::int($request, 'durationMinutes'),
                self::optionalString($request, 'expectedUpdatedAt'),
            )),
            'disableCombination' => $this->combinationPayload($this->combinations->setActive(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
                false,
            )),
            'enableCombination' => $this->combinationPayload($this->combinations->setActive(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
                true,
            )),
            default => throw new BookingValidationException('action', 'Unknown service mutation action.'),
        };
    }

    /** @return array<string, mixed> */
    private function combinationPayload(ServiceCombination $combination): array
    {
        $byKey = [];
        $activeKeys = [];
        foreach ($this->combinations->memberServices($combination->serviceKeys) as $member) {
            $byKey[$member->key] = $member;
            if ($member->isActive) {
                $activeKeys[$member->key] = true;
            }
        }
        $catalog = new BookingServiceCatalog($this->services, $this->combinations);

        return ['combination' => $combination->toAdminPayload(
            self::currentProposal($combination->serviceKeys, $byKey),
            $catalog->isBookable($combination, $activeKeys, $this->combinations->maxServicesPerAppointment()),
        )];
    }

    /**
     * The not-yet-stored subsets of two to `$max` active services, in
     * catalog order (smaller subsets first, then lexicographic by position),
     * as `proposed` candidates. Enumeration stops at the contract bound and
     * says so rather than pretending the list is exhaustive.
     *
     * @param list<string> $activeKeys catalog order
     * @param array<string, true> $stored
     * @param array<string, BookableService> $byKey
     * @return array{candidates: list<array<string, mixed>>, complete: bool}
     */
    private function candidates(array $activeKeys, int $max, array $stored, array $byKey): array
    {
        $candidates = [];
        $bound = $this->contract->combinationCandidatesMax;
        $count = \count($activeKeys);
        for ($size = 2; $size <= min($max, $count); $size++) {
            foreach (self::subsets($activeKeys, $size) as $subset) {
                $members = ServiceCombination::canonicalMembers($subset);
                $key = ServiceCombination::canonicalKey($members);
                if (isset($stored[$key])) {
                    continue;
                }
                if (\count($candidates) >= $bound) {
                    return ['candidates' => $candidates, 'complete' => false];
                }
                $candidates[] = [
                    'key' => $key,
                    'serviceKeys' => $members,
                    'proposedDurationMinutes' => self::currentProposal($members, $byKey),
                    'durationMinutes' => null,
                    'status' => 'proposed',
                    'bookable' => false,
                    'updatedAt' => null,
                ];
            }
        }

        return ['candidates' => $candidates, 'complete' => true];
    }

    /**
     * The advisory proposal from the *current* catalog rows: the plain sum
     * of the members' durations. A member the catalog no longer resolves
     * (cannot happen — rows are never deleted) counts nothing.
     *
     * @param list<string> $members
     * @param array<string, BookableService> $byKey
     */
    private static function currentProposal(array $members, array $byKey): int
    {
        $services = [];
        foreach ($members as $member) {
            if (isset($byKey[$member])) {
                $services[] = $byKey[$member];
            }
        }

        return ServiceCombinationRepository::proposedDuration($services);
    }

    /**
     * @param list<string> $items
     * @return \Generator<int, list<string>>
     */
    private static function subsets(array $items, int $size, int $from = 0): \Generator
    {
        if ($size === 0) {
            yield [];

            return;
        }
        $count = \count($items);
        for ($index = $from; $index <= $count - $size; $index++) {
            foreach (self::subsets($items, $size - 1, $index + 1) as $rest) {
                yield [$items[$index], ...$rest];
            }
        }
    }

    /** @param array<string, mixed> $request */
    private static function string(array $request, string $field): string
    {
        $value = $request[$field] ?? null;
        if (!\is_string($value)) {
            throw new BookingValidationException($field, "The {$field} field must be a string.");
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $request
     * @return list<string>
     */
    private static function stringList(array $request, string $field): array
    {
        $value = $request[$field] ?? null;
        if (!\is_array($value) || !array_is_list($value)) {
            throw new BookingValidationException($field, "The {$field} field must be a list.");
        }
        foreach ($value as $entry) {
            if (!\is_string($entry)) {
                throw new BookingValidationException($field, "The {$field} field must hold strings.");
            }
        }

        /** @var list<string> $value */
        return $value;
    }

    /** @param array<string, mixed> $request */
    private static function optionalString(array $request, string $field): ?string
    {
        if (!\array_key_exists($field, $request)) {
            throw new BookingValidationException($field, "The {$field} field is required.");
        }
        $value = $request[$field];
        if ($value !== null && !\is_string($value)) {
            throw new BookingValidationException($field, "The {$field} field must be a string or null.");
        }

        return $value;
    }

    /** @param array<string, mixed> $request */
    private static function int(array $request, string $field): int
    {
        $value = $request[$field] ?? null;
        if (!\is_int($value)) {
            throw new BookingValidationException($field, "The {$field} field must be an integer.");
        }

        return $value;
    }
}
