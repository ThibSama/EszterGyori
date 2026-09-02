<?php

declare(strict_types=1);

namespace Eszter\Retention;

use Eszter\Database\Database;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * The cron-safe retention sweep (ESZ-140).
 *
 * Applies the frozen customer-data retention policy to bookings whose
 * lifecycle ended long enough ago: confirmed bookings 90 days after
 * `ends_at_utc`, cancelled bookings 90 days after `cancelled_at_utc`. It is
 * the only writer of `bookings.customer_data_erased_at`, and it never deletes
 * a booking, a history row or a notification job.
 *
 * ## Per-booking atomicity, and why the re-check happens under the row lock
 *
 * Each eligible booking is erased in its own transaction:
 *
 *  1. the booking row is re-read `FOR UPDATE` with the eligibility predicate
 *     and `customer_data_erased_at IS NULL` — the lock serialises with the
 *     lifecycle transactions that lock the same row, and the marker predicate
 *     makes a second overlapping retention run skip what the first already
 *     erased;
 *  2. every non-terminal notification job of the booking is retired to the
 *     terminal `retired` status with the frozen code, clearing any lease, so
 *     nothing survives that could deliver from the erased row;
 *  3. the booking is anonymized to the frozen placeholders and the erasure
 *     timestamp is set.
 *
 * The candidate scan is an unlocked read; the per-booking re-check is what
 * decides. That is what makes overlapping runs (two crons, or a restore that
 * reconciles while a scheduled run fires) idempotent rather than merely
 * unlikely to collide.
 *
 * ## What the sweep may write while holding the application snapshot barrier
 *
 * Every mutation goes through `Database`, so each booking transaction holds
 * the shared application barrier: a backup can never capture a booking half
 * erased, and the sweep can never run across a restore's exclusive barrier.
 *
 * ## Counts only
 *
 * The sweep never writes, logs or returns a booking reference or any customer
 * value. Its output is counts and the cutoff — that is the whole interface,
 * and it is what makes the CLI safe to run from cron into a log.
 */
final class BookingRetentionService
{
    public const DEFAULT_BATCH_SIZE = 500;
    public const MAX_BATCH_SIZE = 10_000;

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly RetentionPolicy $policy,
        private readonly NotificationJobRepository $jobs,
    ) {
    }

    /**
     * Erases every eligible booking up to `$limit`.
     *
     * @return array{eligible: int, erased: int, retired: int, cutoffUtc: string}
     */
    public function applyEligible(
        int $limit = self::DEFAULT_BATCH_SIZE,
        ?\DateTimeImmutable $now = null,
    ): array {
        if ($limit < 1 || $limit > self::MAX_BATCH_SIZE) {
            throw new \InvalidArgumentException(
                "Retention batch size must be between 1 and " . self::MAX_BATCH_SIZE . '.',
            );
        }

        $instant = $now ?? $this->clock->now();
        $instant = $instant->setTimezone(new \DateTimeZone('UTC'));
        $cutoffConfirmed = $instant->modify(
            '-' . $this->policy->confirmedExpiryDaysAfterEndsAtUtc . ' days',
        );
        $cutoffCancelled = $instant->modify(
            '-' . $this->policy->cancelledExpiryDaysAfterCancelledAtUtc . ' days',
        );
        $cutoffIso = IsoTimestamp::format(min($cutoffConfirmed, $cutoffCancelled));

        $candidates = $this->database->fetchAll(
            'SELECT id FROM bookings'
            . ' WHERE customer_data_erased_at IS NULL'
            . ' AND ('
            . '   (state = :confirmed AND ends_at_utc <= :cutoff_confirmed)'
            . '   OR (state = :cancelled AND cancelled_at_utc <= :cutoff_cancelled)'
            . ' )'
            . ' ORDER BY id'
            . ' LIMIT ' . $limit,
            [
                'confirmed' => 'confirmed',
                'cancelled' => 'cancelled',
                'cutoff_confirmed' => $cutoffConfirmed->format('Y-m-d H:i:s.v'),
                'cutoff_cancelled' => $cutoffCancelled->format('Y-m-d H:i:s.v'),
            ],
        );

        $erased = 0;
        $retired = 0;

        foreach ($candidates as $candidate) {
            $id = $candidate['id'] ?? null;
            if (!\is_int($id)) {
                throw new \RuntimeException('Retention candidate has no integer id.');
            }

            $outcome = $this->eraseEligibleBooking(
                $id,
                $cutoffConfirmed->format('Y-m-d H:i:s.v'),
                $cutoffCancelled->format('Y-m-d H:i:s.v'),
            );
            if ($outcome['erased']) {
                ++$erased;
                $retired += $outcome['retired'];
            }
        }

        return [
            'eligible' => \count($candidates),
            'erased' => $erased,
            'retired' => $retired,
            'cutoffUtc' => $cutoffIso,
        ];
    }

    /**
     * Erases one booking if and only if it is still eligible.
     *
     * The `FOR UPDATE` re-read is the lock and the second eligibility check in
     * one: it serialises with `BookingRepository::transition()` (which locks
     * the same row) and it re-applies the marker and cutoff predicates against
     * the state that actually exists at erase time, not the state the scan saw.
     *
     * @return array{erased: bool, retired: int}
     */
    private function eraseEligibleBooking(int $id, string $cutoffConfirmed, string $cutoffCancelled): array
    {
        return $this->database->transactional(function () use ($id, $cutoffConfirmed, $cutoffCancelled): array {
            $row = $this->database->fetchOne(
                'SELECT id FROM bookings'
                . ' WHERE id = :id AND customer_data_erased_at IS NULL'
                . ' AND ('
                . '   (state = :confirmed AND ends_at_utc <= :cutoff_confirmed)'
                . '   OR (state = :cancelled AND cancelled_at_utc <= :cutoff_cancelled)'
                . ' )'
                . ' FOR UPDATE',
                [
                    'id' => $id,
                    'confirmed' => 'confirmed',
                    'cancelled' => 'cancelled',
                    'cutoff_confirmed' => $cutoffConfirmed,
                    'cutoff_cancelled' => $cutoffCancelled,
                ],
            );

            if ($row === null) {
                return ['erased' => false, 'retired' => 0];
            }

            $now = $this->clock->now()->setTimezone(new \DateTimeZone('UTC'));
            $nowDatabase = $now->format('Y-m-d H:i:s.v');
            $nowIso = IsoTimestamp::format($now);

            // Retire first, inside the same transaction: no pending or
            // processing job of this booking can outlive the erasure commit.
            $retired = $this->jobs->retireForBooking($id, $this->policy->erasureJobCode);

            $statement = $this->database->run(
                'UPDATE bookings SET'
                . ' customer_name = :name, customer_email = :email,'
                . ' customer_phone = NULL, customer_note = NULL, cancellation_reason = NULL,'
                . ' customer_data_erased_at = :marker, updated_at = :updated'
                . ' WHERE id = :id AND customer_data_erased_at IS NULL',
                [
                    'name' => $this->policy->erasedCustomerName,
                    'email' => $this->policy->erasedCustomerEmail,
                    'marker' => $nowDatabase,
                    'updated' => $nowIso,
                    'id' => $id,
                ],
            );

            if ($statement->rowCount() !== 1) {
                throw new \RuntimeException('Retention could not anonymize booking ' . $id . '.');
            }

            return ['erased' => true, 'retired' => $retired];
        });
    }
}
