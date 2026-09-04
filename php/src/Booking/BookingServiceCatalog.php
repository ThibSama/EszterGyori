<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * Public service discovery and the single "actively bookable service" rule
 * (ESZ-106).
 *
 * `services()` is the public catalogue read. {@see requireActive()} is the one
 * place a service key becomes a bookable service: slot reads and booking
 * revalidation all go through it, so a booking can never be computed or
 * confirmed against a service that is missing or no longer active.
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
                static fn (BookableService $service): array => [
                    'key' => $service->key,
                    'label' => $service->label,
                    'durationMinutes' => $service->durationMinutes,
                ],
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
