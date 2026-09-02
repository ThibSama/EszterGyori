<?php

declare(strict_types=1);

namespace Eszter\Booking;

/** HTTP-facing booking use cases, independent of transport and test storage. */
interface BookingApi
{
    /** @return array<string, mixed> */
    public function services(): array;

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function availability(array $request): array;

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function create(array $request): array;

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminQuery(array $request): array;

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMoveAvailability(array $request): array;

    /**
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutate(array $request): array;

    /**
     * The operational summary (ESZ-065/ESZ-144). Exact SQL aggregations over
     * the whole window for counts and the next confirmed instant; listed
     * entries are bounded and advertise their completeness. It stores nothing
     * of its own.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminSummary(array $request): array;

    /**
     * The stored schedule (ESZ-063/064): weekly rules plus the replacing date
     * exceptions inside one local window.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminAvailability(array $request): array;

    /**
     * Replaces the complete weekly schedule, or refuses and changes nothing.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminReplaceWeeklyAvailability(array $request): array;

    /**
     * Closes a date, opens it exceptionally, or removes the exception so the
     * weekly rules apply again.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutateAvailabilityException(array $request): array;
}
