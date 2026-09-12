<?php

declare(strict_types=1);

namespace Eszter\Legal;

/**
 * ESZ-165 — the legal-information use cases, independent of transport and
 * of test storage.
 *
 * One persisted document (`contracts/legal.ts`) behind three operations: the
 * public read the legal notice and the privacy policy render from, the
 * authenticated read the settings page starts from, and the whole-document
 * save under the revision the administrator last read. The interface exists
 * for the same reason {@see \Eszter\Booking\BookingApi} does: the contract
 * runner replays the frozen cases against an in-memory implementation, and
 * the SQL suite proves the MySQL one.
 */
interface LegalInformationApi
{
    /**
     * The stored document, as the public pages read it.
     *
     * @return array{information: array<string, mixed>}
     */
    public function read(): array;

    /**
     * The stored document with its revision and last write, for the admin.
     *
     * @return array{information: array<string, mixed>, revision: int, updatedAt: ?string}
     */
    public function adminRead(): array;

    /**
     * Replaces the document whole, or refuses and changes nothing.
     *
     * @param array{expectedRevision: int, information: array<string, mixed>} $request
     *        Already validated against `admin-legal-information-save-request.schema.json`.
     * @return array{information: array<string, mixed>, revision: int, updatedAt: ?string}
     * @throws LegalInformationRevisionConflictException When the revision moved.
     */
    public function adminSave(array $request): array;
}
