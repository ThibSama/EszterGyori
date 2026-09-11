<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * Explicit, repeat-safe persistence for validated service combinations and
 * the "services per appointment" setting (ESZ-150).
 *
 * `booking_service_combinations` holds only what the administrator has
 * explicitly validated: a row exists because Esther saved a duration for that
 * membership, never because the server enumerated it. The stored
 * `duration_minutes` is the authority for every new reservation of the
 * combination and nothing here ever recomputes it — a component's duration
 * may move, the proposal shown beside it follows, the validated value does
 * not.
 *
 * Every write can change bookability (a new bookable combination, a new
 * duration, disable/enable, a lower or higher maximum), so every write takes
 * the booking serialization boundary first, inside its own transaction
 * (ESZ-146), exactly as the service catalog's writes do. Nothing here deletes
 * a row: disabling is `is_active = 0`, and a combination that a historical
 * booking names survives whatever happens to its members.
 */
final class ServiceCombinationRepository
{
    private const COLUMNS = 'combination_key, proposed_duration_minutes, duration_minutes,'
        . ' buffer_before_minutes, buffer_after_minutes, is_active, created_at, updated_at';

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly BookingDomainContract $contract,
        private readonly BookingSerializationLock $serialization,
        private readonly BookableServiceRepository $services,
    ) {
    }

    public function find(string $key): ?ServiceCombination
    {
        if (!$this->contract->acceptsCombinationKey($key)) {
            throw new BookingValidationException('combinationKey', 'Malformed combination key.');
        }

        $row = $this->database->fetchOne(
            'SELECT ' . self::COLUMNS . ' FROM booking_service_combinations WHERE combination_key = :key',
            ['key' => $key],
        );

        return $row === null ? null : ServiceCombination::fromRow($row);
    }

    /**
     * Every stored row, disabled included, in creation order (key as the
     * deterministic tie-break).
     *
     * @return list<ServiceCombination>
     */
    public function all(): array
    {
        return array_map(
            ServiceCombination::fromRow(...),
            $this->database->fetchAll(
                'SELECT ' . self::COLUMNS . ' FROM booking_service_combinations'
                . ' ORDER BY created_at ASC, combination_key ASC',
            ),
        );
    }

    /**
     * The configured maximum number of services per appointment: the
     * `system_settings` row, or the contract default while none exists.
     */
    public function maxServicesPerAppointment(): int
    {
        $row = $this->database->fetchOne(
            'SELECT value_json FROM system_settings WHERE setting_key = :key',
            ['key' => $this->contract->maxServicesSettingKey],
        );

        return $row === null ? $this->contract->maxServicesPerAppointmentDefault : $this->maxFromRow($row);
    }

    /**
     * Stores the maximum. Raising it opens larger combinations to booking and
     * lowering it closes them, so the serialization boundary is taken first.
     */
    public function setMaxServicesPerAppointment(int $max): int
    {
        $this->validateMax($max);

        return $this->database->transactional(function () use ($max): int {
            $this->serialization->acquire();
            $now = $this->clock->nowIso();
            $value = (string) json_encode(['max' => $max], JSON_THROW_ON_ERROR);
            $this->database->run(
                'INSERT INTO system_settings (setting_key, value_json, created_at, updated_at)'
                . ' VALUES (:key, :value, :created, :updated) AS incoming'
                . ' ON DUPLICATE KEY UPDATE value_json = incoming.value_json, updated_at = incoming.updated_at',
                [
                    'key' => $this->contract->maxServicesSettingKey,
                    'value' => $value,
                    'created' => $now,
                    'updated' => $now,
                ],
            );

            return $this->maxServicesPerAppointment();
        });
    }

    /**
     * The advisory proposal: the plain sum of the component durations, and
     * nothing else. Shown beside the validated value, never used for a slot.
     *
     * @param list<BookableService> $members
     */
    public static function proposedDuration(array $members): int
    {
        $sum = 0;
        foreach ($members as $member) {
            $sum += $member->durationMinutes;
        }

        return $sum;
    }

    /**
     * Persists the administrator's validated duration for one membership.
     *
     * `$expectedUpdatedAt` is null to create the row (refused with a conflict
     * if a row already exists — the form was stale) and the row's token to
     * replace its duration. The membership must be two to the absolute
     * limit of *existing* services (archived members are allowed here so an
     * administrator can prepare a combination before restoring a service;
     * the combination is simply not bookable until they are active). Buffers
     * are snapshotted from the members at this moment.
     *
     * @param list<string> $serviceKeys
     */
    public function validate(array $serviceKeys, int $durationMinutes, ?string $expectedUpdatedAt): ServiceCombination
    {
        $members = $this->canonicalMembers($serviceKeys);
        $key = ServiceCombination::canonicalKey($members);
        if (
            $durationMinutes < $this->contract->durationMinMinutes
            || $durationMinutes > $this->contract->durationMaxMinutes
        ) {
            throw new BookingValidationException('durationMinutes', 'Combination duration is outside the V1 bounds.');
        }

        return $this->database->transactional(function () use (
            $members,
            $key,
            $durationMinutes,
            $expectedUpdatedAt,
        ): ServiceCombination {
            $this->serialization->acquire();
            $services = $this->memberServices($members);
            $proposed = self::proposedDuration($services);
            $before = 0;
            $after = 0;
            foreach ($services as $service) {
                $before = max($before, $service->bufferBeforeMinutes);
                $after = max($after, $service->bufferAfterMinutes);
            }
            $current = $this->lockedCurrent($key);

            if ($expectedUpdatedAt === null) {
                if ($current !== null) {
                    throw new BookableServiceRevisionConflictException($key, '', $current->updatedAt);
                }
                $now = $this->clock->nowIso();
                $this->database->run(
                    'INSERT INTO booking_service_combinations'
                    . ' (combination_key, proposed_duration_minutes, duration_minutes,'
                    . ' buffer_before_minutes, buffer_after_minutes, is_active, created_at, updated_at)'
                    . ' VALUES (:key, :proposed, :duration, :before, :after, 1, :created, :updated)',
                    [
                        'key' => $key,
                        'proposed' => $proposed,
                        'duration' => $durationMinutes,
                        'before' => $before,
                        'after' => $after,
                        'created' => $now,
                        'updated' => $now,
                    ],
                );
            } else {
                if ($current === null) {
                    throw new BookableServiceNotFoundException($key);
                }
                if ($current->updatedAt !== $expectedUpdatedAt) {
                    throw new BookableServiceRevisionConflictException($key, $expectedUpdatedAt, $current->updatedAt);
                }
                $this->database->run(
                    'UPDATE booking_service_combinations SET proposed_duration_minutes = :proposed,'
                    . ' duration_minutes = :duration, buffer_before_minutes = :before,'
                    . ' buffer_after_minutes = :after, updated_at = :updated WHERE combination_key = :key',
                    [
                        'proposed' => $proposed,
                        'duration' => $durationMinutes,
                        'before' => $before,
                        'after' => $after,
                        'updated' => $this->nextUpdatedAt($current),
                        'key' => $key,
                    ],
                );
            }

            return $this->stored($key);
        });
    }

    /**
     * Disables (`false`) or enables (`true`) one combination for new
     * bookings under its token. Only `is_active` and `updated_at` change.
     */
    public function setActive(string $key, string $expectedUpdatedAt, bool $active): ServiceCombination
    {
        if (!$this->contract->acceptsCombinationKey($key)) {
            throw new BookingValidationException('combinationKey', 'Malformed combination key.');
        }

        return $this->database->transactional(function () use ($key, $expectedUpdatedAt, $active): ServiceCombination {
            $this->serialization->acquire();
            $current = $this->lockedCurrent($key);
            if ($current === null) {
                throw new BookableServiceNotFoundException($key);
            }
            if ($current->updatedAt !== $expectedUpdatedAt) {
                throw new BookableServiceRevisionConflictException($key, $expectedUpdatedAt, $current->updatedAt);
            }
            $this->database->run(
                'UPDATE booking_service_combinations SET is_active = :active, updated_at = :updated'
                . ' WHERE combination_key = :key',
                [
                    'active' => $active ? 1 : 0,
                    'updated' => $this->nextUpdatedAt($current),
                    'key' => $key,
                ],
            );

            return $this->stored($key);
        });
    }

    /**
     * The member rows of a combination, in canonical order, each of which
     * must exist in the catalog (archived or not).
     *
     * @param list<string> $members canonical
     * @return list<BookableService>
     */
    public function memberServices(array $members): array
    {
        $services = [];
        foreach ($members as $memberKey) {
            $service = $this->services->find($memberKey);
            if ($service === null) {
                throw new BookingValidationException('serviceKeys', 'A combination member names no catalog service.');
            }
            $services[] = $service;
        }

        return $services;
    }

    /**
     * The canonical membership of a selection: well-formed, distinct, two to
     * the absolute limit.
     *
     * @param list<string> $serviceKeys
     * @return list<string>
     */
    public function canonicalMembers(array $serviceKeys): array
    {
        foreach ($serviceKeys as $serviceKey) {
            if (!\is_string($serviceKey) || !$this->contract->acceptsServiceKey($serviceKey)) {
                throw new BookingValidationException('serviceKeys', 'Malformed service key.');
            }
        }
        $members = ServiceCombination::canonicalMembers($serviceKeys);
        if (\count($members) !== \count($serviceKeys)) {
            throw new BookingValidationException('serviceKeys', 'A service is selected more than once.');
        }
        if (\count($members) < 2 || \count($members) > $this->contract->maxServicesPerAppointmentLimit) {
            throw new BookingValidationException('serviceKeys', 'A combination has two to the limit of services.');
        }

        return $members;
    }

    private function validateMax(int $max): void
    {
        if ($max < 1 || $max > $this->contract->maxServicesPerAppointmentLimit) {
            throw new BookingValidationException(
                'maxServicesPerAppointment',
                'The maximum number of services per appointment is outside the V1 bounds.',
            );
        }
    }

    /** @param array<string, mixed> $row */
    private function maxFromRow(array $row): int
    {
        $json = $row['value_json'] ?? null;
        $decoded = \is_string($json) ? json_decode($json, true) : null;
        $max = \is_array($decoded) ? ($decoded['max'] ?? null) : null;
        if (!\is_int($max) || $max < 1 || $max > $this->contract->maxServicesPerAppointmentLimit) {
            throw new \RuntimeException('The stored services-per-appointment setting is malformed.');
        }

        return $max;
    }

    /** The row under `SELECT ... FOR UPDATE`; the caller holds the boundary. */
    private function lockedCurrent(string $key): ?ServiceCombination
    {
        $row = $this->database->fetchOne(
            'SELECT ' . self::COLUMNS . ' FROM booking_service_combinations'
            . ' WHERE combination_key = :key FOR UPDATE',
            ['key' => $key],
        );

        return $row === null ? null : ServiceCombination::fromRow($row);
    }

    /** The ESZ-139 rule: a strictly newer token whatever the clock does. */
    private function nextUpdatedAt(ServiceCombination $current): string
    {
        $nowIso = $this->clock->nowIso();
        if (\strcmp($nowIso, $current->updatedAt) > 0) {
            return $nowIso;
        }

        $stored = \DateTimeImmutable::createFromFormat(
            IsoTimestamp::FORMAT,
            $current->updatedAt,
            new \DateTimeZone('UTC'),
        );
        if ($stored === false) {
            throw new \RuntimeException(
                'The stored booking_service_combinations updated_at is not a canonical timestamp.',
            );
        }

        return IsoTimestamp::format($stored->modify('+1 millisecond'));
    }

    private function stored(string $key): ServiceCombination
    {
        $stored = $this->find($key);
        if ($stored === null) {
            throw new \RuntimeException('The service combination disappeared during its own write.');
        }

        return $stored;
    }
}
