<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;

/** Explicit, repeat-safe persistence for operational service configuration. */
final class BookableServiceRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly BookingDomainContract $contract,
    ) {
    }

    public function find(string $key): ?BookableService
    {
        if (!$this->contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Unknown canonical service key.');
        }

        $row = $this->database->fetchOne(
            'SELECT service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at'
            . ' FROM booking_services WHERE service_key = :service_key',
            ['service_key' => $key],
        );

        return $row === null ? null : BookableService::fromRow($row);
    }

    /** @return list<BookableService> */
    public function all(bool $activeOnly = false): array
    {
        $sql = 'SELECT service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at FROM booking_services';

        if ($activeOnly) {
            $sql .= ' WHERE is_active = 1';
        }

        $sql .= ' ORDER BY service_key ASC';

        return array_map(BookableService::fromRow(...), $this->database->fetchAll($sql));
    }

    /**
     * Creates or replaces booking-specific facts for one stable service key.
     *
     * No editorial description or media is accepted here, and no caller is run
     * implicitly: an operator or a future authenticated admin action must supply
     * every value deliberately.
     *
     * @return array{service: BookableService, created: bool}
     */
    public function provision(
        string $key,
        string $label,
        int $durationMinutes,
        int $bufferBeforeMinutes,
        int $bufferAfterMinutes,
        bool $active,
    ): array {
        $label = trim($label);
        $this->validate($key, $label, $durationMinutes, $bufferBeforeMinutes, $bufferAfterMinutes);

        return $this->database->transactional(function () use (
            $key,
            $label,
            $durationMinutes,
            $bufferBeforeMinutes,
            $bufferAfterMinutes,
            $active,
        ): array {
            $existing = $this->find($key);
            $now = $this->clock->nowIso();

            if ($existing === null) {
                $this->database->run(
                    'INSERT INTO booking_services'
                    . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
                    . ' buffer_after_minutes, is_active, created_at, updated_at)'
                    . ' VALUES (:service_key, :label, :duration, :before, :after, :active, :created, :updated)',
                    [
                        'service_key' => $key,
                        'label' => $label,
                        'duration' => $durationMinutes,
                        'before' => $bufferBeforeMinutes,
                        'after' => $bufferAfterMinutes,
                        'active' => $active ? 1 : 0,
                        'created' => $now,
                        'updated' => $now,
                    ],
                );
            } else {
                $this->database->run(
                    'UPDATE booking_services SET booking_label = :label, duration_minutes = :duration,'
                    . ' buffer_before_minutes = :before, buffer_after_minutes = :after,'
                    . ' is_active = :active, updated_at = :updated WHERE service_key = :service_key',
                    [
                        'label' => $label,
                        'duration' => $durationMinutes,
                        'before' => $bufferBeforeMinutes,
                        'after' => $bufferAfterMinutes,
                        'active' => $active ? 1 : 0,
                        'updated' => $now,
                        'service_key' => $key,
                    ],
                );
            }

            $stored = $this->find($key);
            if ($stored === null) {
                throw new \RuntimeException('The bookable service disappeared during provisioning.');
            }

            return ['service' => $stored, 'created' => $existing === null];
        });
    }

    private function validate(string $key, string $label, int $duration, int $before, int $after): void
    {
        if (!$this->contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Unknown canonical service key.');
        }
        if ($label === '' || mb_strlen($label) > $this->contract->labelMaxLength) {
            throw new BookingValidationException('bookingLabel', 'Booking label is empty or too long.');
        }
        if ($duration < $this->contract->durationMinMinutes || $duration > $this->contract->durationMaxMinutes) {
            throw new BookingValidationException('durationMinutes', 'Service duration is outside the V1 bounds.');
        }
        foreach (['bufferBeforeMinutes' => $before, 'bufferAfterMinutes' => $after] as $field => $value) {
            if ($value < 0 || $value > $this->contract->bufferMaxMinutes) {
                throw new BookingValidationException($field, 'Service buffer is outside the V1 bounds.');
            }
        }
    }
}
