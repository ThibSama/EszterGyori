<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * The back-office side of the service catalog (ESZ-149, ESZ-150).
 *
 * Reads return every row, archived included: an archived service still
 * names historical bookings the calendar must render. Since ESZ-150 the same
 * read carries the configured maximum number of services per appointment
 * and the combinations: every stored override (a custom duration or a
 * disabling exception, whatever its members' state) followed by every
 * membership that has no row — the subsets of two to `max` active services,
 * in catalog order, bounded by the contract with an explicit completeness
 * flag.
 *
 * Since domain version 15 a membership with no row is *bookable by default*,
 * not a candidate awaiting approval, and every row of the list says so the
 * same way: the automatic sum, the custom duration when one is stored, the
 * effective duration a reservation would use, and the one bookability flag —
 * all of them {@see ServiceCombinationPolicy}'s answer, never restated here.
 * So Esther never has to click anything to make a normal combination work;
 * the panel's actions exist only to override the default.
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
        foreach ($this->combinations->all() as $override) {
            $stored[$override->key] = true;
            $combinations[] = $catalog->effectiveCombination(
                self::membersOf($override->serviceKeys, $byKey),
                $override,
                $max,
            )->toAdminPayload();
        }

        ['candidates' => $candidates, 'complete' => $complete] = $this->candidates(
            array_keys($activeKeys),
            $max,
            $stored,
            $byKey,
            $catalog,
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
                self::optionalInt($request, 'durationMinutes'),
                self::optionalString($request, 'expectedUpdatedAt'),
            )),
            // Domain version 15: disabling names the membership, because the
            // combination being disabled usually has no row to name.
            'disableCombination' => $this->combinationPayload($this->combinations->disable(
                self::stringList($request, 'serviceKeys'),
                self::optionalString($request, 'expectedUpdatedAt'),
            )),
            'enableCombination' => $this->combinationPayload($this->combinations->enable(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
            )),
            default => throw new BookingValidationException('action', 'Unknown service mutation action.'),
        };
    }

    /** @return array<string, mixed> */
    private function combinationPayload(ServiceCombination $override): array
    {
        $catalog = new BookingServiceCatalog($this->services, $this->combinations);

        return ['combination' => $catalog->effectiveCombination(
            $this->combinations->memberServices($override->serviceKeys),
            $override,
            $this->combinations->maxServicesPerAppointment(),
        )->toAdminPayload()];
    }

    /**
     * The subsets of two to `$max` active services that carry no stored row,
     * in catalog order (smaller subsets first, then lexicographic by
     * position). Domain version 15: each is *bookable by default* for the sum
     * of its members, so it is listed to be seen and optionally overridden,
     * not to be approved. Enumeration stops at the contract bound and says so
     * rather than pretending the list is exhaustive.
     *
     * @param list<string> $activeKeys catalog order
     * @param array<string, true> $stored
     * @param array<string, BookableService> $byKey
     * @return array{candidates: list<array<string, mixed>>, complete: bool}
     */
    private function candidates(
        array $activeKeys,
        int $max,
        array $stored,
        array $byKey,
        BookingServiceCatalog $catalog,
    ): array {
        $candidates = [];
        $bound = $this->contract->combinationCandidatesMax;
        $count = \count($activeKeys);
        for ($size = 2; $size <= min($max, $count); $size++) {
            foreach (self::subsets($activeKeys, $size) as $subset) {
                $members = ServiceCombination::canonicalMembers($subset);
                if (isset($stored[ServiceCombination::canonicalKey($members)])) {
                    continue;
                }
                if (\count($candidates) >= $bound) {
                    return ['candidates' => $candidates, 'complete' => false];
                }
                $candidates[] = $catalog
                    ->effectiveCombination(self::membersOf($members, $byKey), null, $max)
                    ->toAdminPayload();
            }
        }

        return ['candidates' => $candidates, 'complete' => true];
    }

    /**
     * The *current* catalog rows of a membership, in canonical order, so the
     * policy sees the durations, buffers and activity as they are now. A
     * member the catalog no longer resolves (cannot happen — rows are never
     * deleted) is skipped rather than fabricated.
     *
     * @param list<string> $members
     * @param array<string, BookableService> $byKey
     * @return list<BookableService>
     */
    private static function membersOf(array $members, array $byKey): array
    {
        $services = [];
        foreach ($members as $member) {
            if (isset($byKey[$member])) {
                $services[] = $byKey[$member];
            }
        }

        return $services;
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

    /**
     * Domain version 15 — a null combination duration is meaningful: it
     * clears the custom duration and returns the membership to the sum.
     *
     * @param array<string, mixed> $request
     */
    private static function optionalInt(array $request, string $field): ?int
    {
        if (!\array_key_exists($field, $request)) {
            throw new BookingValidationException($field, "The {$field} field is required.");
        }
        $value = $request[$field];
        if ($value !== null && !\is_int($value)) {
            throw new BookingValidationException($field, "The {$field} field must be an integer or null.");
        }

        return $value;
    }
}
