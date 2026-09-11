<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * The back-office side of the service catalog (ESZ-149).
 *
 * Reads return every row, archived included: an archived service still
 * names historical bookings the calendar must render. Mutations are the
 * closed set the contract freezes — create, update, archive, restore — each
 * delegated to one repository write that owns its transaction, its
 * serialization boundary and its optimistic-concurrency check. Nothing here
 * stores anything of its own, and nothing here deletes.
 *
 * Requests arrive already validated against
 * `admin-service-mutation-request.schema.json`; the repository re-validates
 * the domain bounds for defence in depth, so a shape the schema admits but
 * the domain refuses is still a `BookingValidationException`.
 */
final class BookingServiceAdministration
{
    public function __construct(private readonly BookableServiceRepository $services)
    {
    }

    /** @return array<string, mixed> */
    public function adminServices(): array
    {
        return [
            'services' => array_map(
                static fn (BookableService $service): array => $service->toAdminPayload(),
                $this->services->all(),
            ),
        ];
    }

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutateService(array $request): array
    {
        $action = $request['action'] ?? null;

        $service = match ($action) {
            'create' => $this->services->create(
                self::string($request, 'label'),
                self::string($request, 'description'),
                self::int($request, 'durationMinutes'),
                self::optionalString($request, 'imageSrc'),
            ),
            'update' => $this->services->update(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
                self::string($request, 'label'),
                self::string($request, 'description'),
                self::int($request, 'durationMinutes'),
                self::optionalString($request, 'imageSrc'),
            ),
            'archive' => $this->services->setActive(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
                false,
            ),
            'restore' => $this->services->setActive(
                self::string($request, 'key'),
                self::string($request, 'expectedUpdatedAt'),
                true,
            ),
            default => throw new BookingValidationException('action', 'Unknown service mutation action.'),
        };

        return ['service' => $service->toAdminPayload()];
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
