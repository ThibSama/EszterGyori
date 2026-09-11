<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * Public service discovery and the single "actively bookable service" rule
 * (ESZ-106, ESZ-149).
 *
 * `services()` is the public catalogue read: every active row with the
 * name, description, duration and image the reservation page renders — the
 * catalog is the authority and the page matches nothing against SiteContent.
 * {@see requireActive()} is the one place a service key becomes a bookable
 * service: slot reads and booking revalidation all go through it, so a
 * booking can never be computed or confirmed against a service that is
 * missing or archived.
 */
final class BookingServiceCatalog
{
    public function __construct(private readonly BookableServiceRepository $services)
    {
    }

    /** @return array<string, mixed> */
    public function services(): array
    {
        return [
            'services' => array_map(
                static fn (BookableService $service): array => $service->toPublicPayload(),
                $this->services->all(true),
            ),
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
}
