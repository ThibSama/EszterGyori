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

    /**
     * ESZ-152 — creates, updates or removes one planning constraint (a
     * flexible pause, or a strict unavailability, closure or leave), warning
     * about the confirmed appointments a strict one overlaps without
     * altering them.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutateAvailabilityConstraint(array $request): array;

    /**
     * The whole service catalog, archived rows included (ESZ-149).
     *
     * @return array<string, mixed>
     */
    public function adminServices(): array;

    /**
     * Creates, updates, archives or restores one catalog service, or refuses
     * and changes nothing (ESZ-149).
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminMutateService(array $request): array;

    /**
     * ESZ-163 — resolves a GDPR requester's scope: one booking by reference,
     * or one page of the live bookings a customer e-mail names.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminPrivacyRequestSearch(array $request): array;

    /**
     * ESZ-163 — reads the GDPR request register: one history page or one
     * record by id.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminPrivacyRequests(array $request): array;

    /**
     * ESZ-163 — records one reviewed GDPR request. Writes the register only:
     * no booking or customer row changes and nothing is exported.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminRecordPrivacyRequest(array $request): array;

    /**
     * ESZ-164 — executes one right (export, rectify, anonymize, restrict,
     * lift) against a recorded request's stored booking links, and answers
     * with the record and the scope as they now stand.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function adminExecutePrivacyRequestAction(array $request): array;
}
