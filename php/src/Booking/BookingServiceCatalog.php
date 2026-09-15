<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * Public service discovery and the single "actively bookable" rule
 * (ESZ-106, ESZ-149, ESZ-150, corrected in domain version 15).
 *
 * `services()` is the public catalogue read: every active row with the
 * name, description, duration and image the reservation page renders, plus
 * the configured maximum number of services per appointment and — since the
 * combination rule became default-allow — the *exceptions* to it. Every set
 * of up to the maximum of active services is bookable for the sum of its
 * component durations without being listed at all; a membership appears in
 * `combinations` only because Esther disabled it or gave it a custom
 * duration, so the payload is bounded by what she stored rather than by the
 * combinatorics of the catalog. The catalog is the authority and the page
 * matches nothing against SiteContent.
 *
 * {@see requireOffer()} is the one place a selection of service keys becomes
 * something a slot can be computed or confirmed for: slot reads, booking
 * creation and admin moves all go through it, and it asks
 * {@see ServiceCombinationPolicy} rather than restating the rule. So a
 * reservation can never be computed against a missing or archived service, an
 * explicitly disabled combination or a selection larger than the configured
 * maximum — and an implicit combination with no stored row is accepted by
 * exactly the same path the public selector offered it on.
 */
final class BookingServiceCatalog
{
    private readonly ServiceCombinationPolicy $policy;

    public function __construct(
        private readonly BookableServiceRepository $services,
        private readonly ServiceCombinationRepository $combinations,
        ?ServiceCombinationPolicy $policy = null,
    ) {
        $this->policy = $policy ?? new ServiceCombinationPolicy();
    }

    /** @return array<string, mixed> */
    public function services(): array
    {
        $active = $this->services->all(true);
        $byKey = [];
        foreach ($active as $service) {
            $byKey[$service->key] = $service;
        }
        $max = $this->combinations->maxServicesPerAppointment();

        // Only the stored exceptions are published, and only those the
        // visitor could otherwise build: every member active and the size
        // within the configured maximum. Everything else is implied by the
        // default-allow rule the page applies itself.
        $exceptions = [];
        foreach ($this->combinations->all() as $stored) {
            if (\count($stored->serviceKeys) > $max) {
                continue;
            }
            $members = [];
            foreach ($stored->serviceKeys as $memberKey) {
                if (!isset($byKey[$memberKey])) {
                    continue 2;
                }
                $members[] = $byKey[$memberKey];
            }
            $effective = $this->policy->effectiveCombination($members, $stored, $max);
            if ($effective->isImplicit()) {
                continue;
            }
            $exceptions[] = $effective->toPublicPayload();
        }

        return [
            'services' => array_map(
                static fn (BookableService $service): array => $service->toPublicPayload(),
                $active,
            ),
            'maxServicesPerAppointment' => $max,
            'combinations' => $exceptions,
        ];
    }

    public function requireActive(string $key): BookableService
    {
        $service = $this->services->find($key);
        if ($service === null || !$service->isActive) {
            throw new BookingValidationException('serviceKey', 'Service is not actively bookable.');
        }

        return $service;
    }

    /**
     * The offer a selection names, or a refusal.
     *
     * One key is the active service itself. Two or more are canonicalised,
     * bounded by the configured maximum, resolved to active catalog rows and
     * then handed — with the stored override row for that membership, if any
     * — to the policy. Bookable by default; refused only when the policy says
     * the membership is explicitly disabled.
     *
     * @param list<string> $serviceKeys
     */
    public function requireOffer(array $serviceKeys): BookableOffer
    {
        if (\count($serviceKeys) === 1) {
            return BookableOffer::ofService($this->requireActive($serviceKeys[0]));
        }

        return BookableOffer::ofCombination($this->requireEffectiveCombination($serviceKeys));
    }

    /**
     * The effective policy for a selection of two or more services: the one
     * resolution every server-side caller shares.
     *
     * @param list<string> $serviceKeys in any order
     */
    public function requireEffectiveCombination(array $serviceKeys): EffectiveCombination
    {
        $members = $this->combinations->canonicalMembers($serviceKeys);
        $max = $this->combinations->maxServicesPerAppointment();
        if (\count($members) > $max) {
            throw new BookingValidationException('serviceKeys', 'More services than one appointment may hold.');
        }
        $effective = $this->policy->effectiveCombination(
            array_map($this->requireActive(...), $members),
            $this->combinations->find(ServiceCombination::canonicalKey($members)),
            $max,
        );
        if (!$effective->bookable) {
            throw new BookingValidationException('serviceKeys', 'This combination of services is not bookable.');
        }

        return $effective;
    }

    /**
     * The effective policy for one membership, from rows the caller has
     * already read — the back-office lists hundreds of these and must not
     * issue a query per membership.
     *
     * @param list<BookableService> $members canonical order
     */
    public function effectiveCombination(array $members, ?ServiceCombination $stored, int $max): EffectiveCombination
    {
        return $this->policy->effectiveCombination($members, $stored, $max);
    }
}
