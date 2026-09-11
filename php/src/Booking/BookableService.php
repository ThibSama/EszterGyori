<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * One canonical row of the operational service catalog (ESZ-041, ESZ-149).
 *
 * Since ESZ-149 the row carries the editorial facts the reservation page
 * renders — the name (`booking_label`), the description and one managed
 * image reference — beside the facts a slot computation reads. `updatedAt`
 * doubles as the row's optimistic-concurrency token for admin mutations,
 * exactly as a booking's does (ESZ-139).
 */
final class BookableService
{
    public function __construct(
        public readonly string $key,
        public readonly string $label,
        public readonly string $description,
        public readonly ?string $imageSrc,
        public readonly int $durationMinutes,
        public readonly int $bufferBeforeMinutes,
        public readonly int $bufferAfterMinutes,
        public readonly bool $isActive,
        public readonly string $createdAt,
        public readonly string $updatedAt,
    ) {
    }

    /** @param array<string, mixed> $row */
    public static function fromRow(array $row): self
    {
        $key = $row['service_key'] ?? null;
        $label = $row['booking_label'] ?? null;
        $description = $row['description'] ?? null;
        $imageSrc = $row['image_src'] ?? null;
        $duration = $row['duration_minutes'] ?? null;
        $before = $row['buffer_before_minutes'] ?? null;
        $after = $row['buffer_after_minutes'] ?? null;
        $active = $row['is_active'] ?? null;
        $created = $row['created_at'] ?? null;
        $updated = $row['updated_at'] ?? null;

        if (
            !\is_string($key) || !\is_string($label) || !\is_string($description)
            || ($imageSrc !== null && !\is_string($imageSrc))
            || !\is_int($duration) || !\is_int($before) || !\is_int($after)
            || !\is_string($created) || !\is_string($updated)
        ) {
            throw new \RuntimeException('booking_services row is malformed.');
        }

        return new self(
            $key,
            $label,
            $description,
            $imageSrc,
            $duration,
            $before,
            $after,
            $active === 1 || $active === '1' || $active === true,
            $created,
            $updated,
        );
    }

    /**
     * The back-office view of the row (ESZ-149): the frozen
     * `adminBookableService` wire shape. Buffers stay server-side — the
     * back-office edits name, description, duration and image, nothing else.
     *
     * @return array<string, mixed>
     */
    public function toAdminPayload(): array
    {
        return [
            'key' => $this->key,
            'label' => $this->label,
            'description' => $this->description,
            'durationMinutes' => $this->durationMinutes,
            'imageSrc' => $this->imageSrc,
            'status' => $this->isActive ? 'active' : 'archived',
            'createdAt' => $this->createdAt,
            'updatedAt' => $this->updatedAt,
        ];
    }

    /**
     * The public discovery view (ESZ-149): what the reservation page renders
     * for one active service and nothing an anonymous caller has no use for.
     *
     * @return array<string, mixed>
     */
    public function toPublicPayload(): array
    {
        return [
            'key' => $this->key,
            'label' => $this->label,
            'description' => $this->description,
            'durationMinutes' => $this->durationMinutes,
            'imageSrc' => $this->imageSrc,
        ];
    }
}
