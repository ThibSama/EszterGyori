<?php

declare(strict_types=1);

namespace Eszter\Privacy;

use Eszter\Booking\BookingValidationException;
use Eszter\Database\Database;
use Eszter\Support\Clock;

/**
 * MySQL persistence for the GDPR request register (ESZ-163).
 *
 * ## What is written, and what never is
 *
 * A record is the frozen type, the reception date, the deadline derived from
 * it, the automatic status, the closure instant and the explicitly selected
 * booking references. The repository has no parameter through which a
 * requester's e-mail, message or identity document could arrive, and the
 * schema has no column for one: minimisation is enforced twice.
 *
 * ## The lifecycle is owned here
 *
 * Creation stores the policy's initial status. {@see startExecution()} and
 * {@see close()} are the only ways forward, each a single conditional
 * `UPDATE ... WHERE status = :from` under the row lock, so a concurrent
 * second transition finds the row already moved and is refused rather than
 * applied twice. Closing writes `closed_at_utc` in the same statement as the
 * status — the schema's closure CHECK makes the two inseparable. ESZ-164
 * calls these when it executes a right; ESZ-163 only ever creates.
 *
 * ## Retention
 *
 * {@see purgeClosedBefore()} deletes closed records whose closure instant is
 * at or before the cutoff, with their references (cascade). It never sees an
 * open record: the predicate names `status = 'closed'`, so a received or
 * in-progress request is never age-purged whatever its age.
 */
final class PrivacyRequestRepository
{
    private const SELECT_COLUMNS = 'id, request_type, status, received_date, deadline_date,'
        . ' closed_at_utc, created_at, updated_at';

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly PrivacyRequestPolicy $policy,
    ) {
    }

    /**
     * Records one reviewed request.
     *
     * `$bookingReferences` are stored exactly as given, in order — the
     * caller has already resolved each one against a live booking and
     * refused duplicates. An empty list is a confirmed empty scope.
     *
     * @param list<string> $bookingReferences
     */
    public function record(string $type, \DateTimeImmutable $receivedDate, array $bookingReferences): PrivacyRequest
    {
        if (!$this->policy->acceptsType($type)) {
            throw new BookingValidationException('type', 'Privacy request type is not one of the frozen V1 types.');
        }
        if (\count($bookingReferences) > $this->policy->maxBookingReferences) {
            throw new BookingValidationException('bookingReferences', 'Too many booking references for one request.');
        }
        if (\count(array_unique($bookingReferences)) !== \count($bookingReferences)) {
            throw new BookingValidationException('bookingReferences', 'A booking reference is selected twice.');
        }

        $deadline = PrivacyRequestDeadline::from($receivedDate, $this->policy->deadlineMonths);
        $now = $this->clock->nowIso();

        return $this->database->transactional(function () use (
            $type,
            $receivedDate,
            $deadline,
            $bookingReferences,
            $now,
        ): PrivacyRequest {
            $this->database->run(
                'INSERT INTO privacy_requests'
                . ' (request_type, status, received_date, deadline_date, closed_at_utc, created_at, updated_at)'
                . ' VALUES (:type, :status, :received, :deadline, NULL, :created, :updated)',
                [
                    'type' => $type,
                    'status' => $this->policy->initialStatus,
                    'received' => $receivedDate->format('Y-m-d'),
                    'deadline' => $deadline->format('Y-m-d'),
                    'created' => $now,
                    'updated' => $now,
                ],
            );
            $id = (int) $this->database->pdo()->lastInsertId();

            foreach ($bookingReferences as $position => $reference) {
                $this->database->run(
                    'INSERT INTO privacy_request_bookings (request_id, booking_reference, position)'
                    . ' VALUES (:request, :reference, :position)',
                    ['request' => $id, 'reference' => $reference, 'position' => $position],
                );
            }

            return $this->required($id);
        });
    }

    public function find(int $id): ?PrivacyRequest
    {
        if ($id < 1) {
            throw new BookingValidationException('id', 'Privacy request id must be positive.');
        }

        $row = $this->database->fetchOne(
            'SELECT ' . self::SELECT_COLUMNS . ' FROM privacy_requests WHERE id = :id',
            ['id' => $id],
        );

        return $row === null ? null : PrivacyRequest::fromRow($row, $this->referencesOf($id));
    }

    /**
     * One page of the register, newest first.
     *
     * The continuation is the internal id of the last record the previous
     * page exposed; the next page begins strictly before it. `pageSize + 1`
     * rows are fetched so `hasMore` comes from the surplus row and no page
     * is silently clipped.
     *
     * @return array{rows: list<PrivacyRequest>, hasMore: bool}
     */
    public function page(?int $beforeId, int $pageSize): array
    {
        if ($pageSize < 1 || $pageSize > $this->policy->historyPageSize) {
            throw new BookingValidationException('pageSize', 'Privacy request page size is outside the bounds.');
        }
        if ($beforeId !== null && $beforeId < 1) {
            throw new BookingValidationException('cursor', 'Privacy request cursor is malformed.');
        }

        $rows = $this->database->fetchAll(
            'SELECT ' . self::SELECT_COLUMNS . ' FROM privacy_requests'
            . ($beforeId === null ? '' : ' WHERE id < :before')
            . ' ORDER BY id DESC LIMIT ' . ($pageSize + 1),
            $beforeId === null ? [] : ['before' => $beforeId],
        );

        $records = [];
        foreach (\array_slice($rows, 0, $pageSize) as $row) {
            $id = $row['id'] ?? null;
            if (!\is_int($id)) {
                throw new \RuntimeException('privacy_requests row has no integer id.');
            }
            $records[] = PrivacyRequest::fromRow($row, $this->referencesOf($id));
        }

        return ['rows' => $records, 'hasMore' => \count($rows) > $pageSize];
    }

    /** ESZ-164 — the execution of the right has started. */
    public function startExecution(int $id): PrivacyRequest
    {
        return $this->transition($id, 'in_progress');
    }

    /**
     * ESZ-164 — the action completed. The closure instant is written by the
     * same statement as the status: there is no state in which one is set
     * without the other.
     */
    public function close(int $id): PrivacyRequest
    {
        return $this->transition($id, 'closed');
    }

    private function transition(int $id, string $to): PrivacyRequest
    {
        if (!$this->policy->acceptsStatus($to)) {
            throw new BookingValidationException('status', 'Unknown privacy request status.');
        }

        return $this->database->transactional(function () use ($id, $to): PrivacyRequest {
            $row = $this->database->fetchOne(
                'SELECT status FROM privacy_requests WHERE id = :id FOR UPDATE',
                ['id' => $id],
            );
            if ($row === null) {
                throw new PrivacyRequestNotFoundException($id);
            }
            $from = \is_string($row['status'] ?? null) ? $row['status'] : '';
            if (!\in_array($to, $this->policy->nextStatuses($from), true)) {
                throw new InvalidPrivacyRequestTransitionException($from, $to);
            }

            $now = $this->clock->now()->setTimezone(new \DateTimeZone('UTC'));
            $statement = $this->database->run(
                'UPDATE privacy_requests SET status = :to,'
                . ' closed_at_utc = ' . ($to === 'closed' ? ':closed' : 'NULL') . ','
                . ' updated_at = :updated'
                . ' WHERE id = :id AND status = :from',
                [
                    'to' => $to,
                    'updated' => $this->clock->nowIso(),
                    'id' => $id,
                    'from' => $from,
                ] + ($to === 'closed' ? ['closed' => $now->format('Y-m-d H:i:s.v')] : []),
            );
            if ($statement->rowCount() !== 1) {
                throw new InvalidPrivacyRequestTransitionException($from, $to);
            }

            return $this->required($id);
        });
    }

    /**
     * The three-year purge (ESZ-163 retention). Deletes at most `$limit`
     * closed records whose closure instant is at or before the cutoff, with
     * their references, and returns how many. Open records are never
     * candidates.
     */
    public function purgeClosedBefore(\DateTimeImmutable $cutoffUtc, int $limit): int
    {
        if ($limit < 1) {
            throw new \InvalidArgumentException('The purge limit must be positive.');
        }

        $statement = $this->database->run(
            'DELETE FROM privacy_requests'
            . ' WHERE status = :closed AND closed_at_utc IS NOT NULL AND closed_at_utc <= :cutoff'
            . ' ORDER BY id LIMIT ' . $limit,
            [
                'closed' => 'closed',
                'cutoff' => $cutoffUtc->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.v'),
            ],
        );

        return $statement->rowCount();
    }

    /** @return list<string> */
    private function referencesOf(int $id): array
    {
        $references = [];
        foreach (
            $this->database->fetchAll(
                'SELECT booking_reference FROM privacy_request_bookings WHERE request_id = :id ORDER BY position',
                ['id' => $id],
            ) as $row
        ) {
            $reference = $row['booking_reference'] ?? null;
            if (!\is_string($reference)) {
                throw new \RuntimeException('privacy_request_bookings row is malformed.');
            }
            $references[] = $reference;
        }

        return $references;
    }

    private function required(int $id): PrivacyRequest
    {
        return $this->find($id) ?? throw new PrivacyRequestNotFoundException($id);
    }
}
