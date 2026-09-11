<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * Public service discovery and the single "actively bookable" rule
 * (ESZ-106, ESZ-149, ESZ-150).
 *
 * `services()` is the public catalogue read: every active row with the
 * name, description, duration and image the reservation page renders, plus
 * — since ESZ-150 — the configured maximum number of services per
 * appointment and the combinations that can be booked right now. The
 * catalog is the authority and the page matches nothing against SiteContent.
 *
 * {@see requireOffer()} is the one place a selection of service keys becomes
 * something a slot can be computed or confirmed for: slot reads, booking
 * creation and admin moves all go through it, so a reservation can never be
 * computed against a missing or archived service, an unvalidated or disabled
 * combination, or a selection larger than the configured maximum.
 */
final class BookingServiceCatalog
{
    public function __construct(
        private readonly BookableServiceRepository $services,
        private readonly ServiceCombinationRepository $combinations,
    ) {
    }

    /** @return array<string, mixed> */
    public function services(): array
    {
        $active = $this->services->all(true);
        $activeKeys = [];
        foreach ($active as $service) {
            $activeKeys[$service->key] = true;
        }
        $max = $this->combinations->maxServicesPerAppointment();

        $bookable = [];
        foreach ($this->combinations->all() as $combination) {
            if ($this->isBookable($combination, $activeKeys, $max)) {
                $bookable[] = $combination->toPublicPayload();
            }
        }

        return [
            'services' => array_map(
                static fn (BookableService $service): array => $service->toPublicPayload(),
                $active,
            ),
            'maxServicesPerAppointment' => $max,
            'combinations' => $bookable,
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
     * The offer a selection names, or a refusal (ESZ-150).
     *
     * One key is the active service itself. Two or more are canonicalised
     * and resolved against the persisted combinations: the row must exist,
     * be active, every member must be an active service and the count must
     * be within the configured maximum. There is no implicit combination and
     * no fallback to a single service.
     *
     * @param list<string> $serviceKeys
     */
    public function requireOffer(array $serviceKeys): BookableOffer
    {
        if (\count($serviceKeys) === 1) {
            return BookableOffer::ofService($this->requireActive($serviceKeys[0]));
        }

        $members = $this->combinations->canonicalMembers($serviceKeys);
        if (\count($members) > $this->combinations->maxServicesPerAppointment()) {
            throw new BookingValidationException('serviceKeys', 'More services than one appointment may hold.');
        }
        $combination = $this->combinations->find(ServiceCombination::canonicalKey($members));
        if ($combination === null || !$combination->isActive) {
            throw new BookingValidationException('serviceKeys', 'This combination of services is not bookable.');
        }
        $offer = BookableOffer::ofCombination($combination, array_map($this->requireActive(...), $members));
        if (!$offer->isActive) {
            throw new BookingValidationException('serviceKeys', 'This combination of services is not bookable.');
        }

        return $offer;
    }

    /**
     * Whether a stored combination can be booked now, given the active keys
     * and the configured maximum. The same rule `requireOffer()` applies,
     * evaluated without a query per member so discovery stays one read.
     *
     * @param array<string, true> $activeKeys
     */
    public function isBookable(ServiceCombination $combination, array $activeKeys, int $max): bool
    {
        if (!$combination->isActive || \count($combination->serviceKeys) > $max) {
            return false;
        }
        foreach ($combination->serviceKeys as $member) {
            if (!isset($activeKeys[$member])) {
                return false;
            }
        }

        return true;
    }
}
