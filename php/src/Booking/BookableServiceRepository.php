<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * Explicit, repeat-safe persistence for the operational service catalog
 * (ESZ-041, ESZ-149).
 *
 * `booking_services` is the single catalog: there is no parallel CRUD store.
 * Every write below that can change *bookability* — a new active row, an
 * archive or restore, a duration change, the operator's provisioning of the
 * slot-shaping facts — takes the booking serialization boundary first, inside
 * its own transaction (ESZ-146): a concurrent create/move is ordered by
 * whoever acquires `booking_resource_locks.primary` first, and one that
 * starts behind a committed change re-reads the service and can confirm only
 * a slot the new shape still offers.
 *
 * Every write that can make an image reference durable runs under the
 * {@see ServiceImageReferencePolicy}, which resolves the path against the
 * media catalogue and holds the media/content boundary across the commit.
 *
 * Nothing here deletes a row. Archiving is `is_active = 0`; the key, the row
 * and every booking whose foreign key names it survive.
 */
final class BookableServiceRepository
{
    private const COLUMNS = 'service_key, booking_label, description, image_src, duration_minutes,'
        . ' buffer_before_minutes, buffer_after_minutes, is_active, created_at, updated_at';

    /** Deterministic fallback stem when a name yields no usable slug characters. */
    private const FALLBACK_KEY_STEM = 'prestation';

    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly BookingDomainContract $contract,
        private readonly BookingSerializationLock $serialization,
        private readonly ServiceImageReferencePolicy $images = new NullServiceImageReferencePolicy(),
    ) {
    }

    public function find(string $key): ?BookableService
    {
        if (!$this->contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Malformed service key.');
        }

        $row = $this->database->fetchOne(
            'SELECT ' . self::COLUMNS . ' FROM booking_services WHERE service_key = :service_key',
            ['service_key' => $key],
        );

        return $row === null ? null : BookableService::fromRow($row);
    }

    /**
     * Every row, in catalog order: creation order first (so a newly added
     * service lands last, where the administrator expects it), key as the
     * deterministic tie-break.
     *
     * @return list<BookableService>
     */
    public function all(bool $activeOnly = false): array
    {
        $sql = 'SELECT ' . self::COLUMNS . ' FROM booking_services';

        if ($activeOnly) {
            $sql .= ' WHERE is_active = 1';
        }

        $sql .= ' ORDER BY created_at ASC, service_key ASC';

        return array_map(BookableService::fromRow(...), $this->database->fetchAll($sql));
    }

    /**
     * Whether any catalog row — active or archived — references this managed
     * media path. Archived rows count: restoring the service must not reveal
     * a broken image.
     */
    public function referencesImage(string $publicPath): bool
    {
        return $this->database->fetchOne(
            'SELECT service_key FROM booking_services WHERE image_src = :path LIMIT 1',
            ['path' => $publicPath],
        ) !== null;
    }

    /**
     * Creates a service from the back-office (ESZ-149).
     *
     * The key is derived from the name — a lowercase ASCII slug of the frozen
     * shape, de-duplicated with a numeric suffix — and never changes again.
     * A caller may pass an explicit key instead (the operator CLI does, for
     * the keys that existed before the catalog was administrable). The new
     * row is active with zero buffers.
     */
    public function create(
        string $label,
        string $description,
        int $durationMinutes,
        ?string $imageSrc,
        ?string $key = null,
    ): BookableService {
        $label = trim($label);
        $description = trim($description);
        $this->validateEditorial($label, $description);
        $this->validateShape($durationMinutes, 0, 0);
        if ($key !== null && !$this->contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Malformed service key.');
        }

        return $this->images->withImageReference(
            $imageSrc,
            fn (): BookableService => $this->database->transactional(function () use (
                $label,
                $description,
                $durationMinutes,
                $imageSrc,
                $key,
            ): BookableService {
                // A new active service is new bookability: serialize first.
                $this->serialization->acquire();
                $key ??= $this->deriveKey($label);
                if ($this->find($key) !== null) {
                    throw new BookingValidationException('serviceKey', 'A service with this key already exists.');
                }
                $now = $this->clock->nowIso();
                $this->insert($key, $label, $description, $imageSrc, $durationMinutes, 0, 0, true, $now);

                return $this->stored($key);
            }),
        );
    }

    /**
     * Replaces the editorial facts and the duration of one service under its
     * optimistic-concurrency token (ESZ-149). Buffers and activity are left
     * untouched; the serialization boundary is taken because a duration
     * change reshapes every future slot.
     */
    public function update(
        string $key,
        string $expectedUpdatedAt,
        string $label,
        string $description,
        int $durationMinutes,
        ?string $imageSrc,
    ): BookableService {
        $label = trim($label);
        $description = trim($description);
        $this->validateEditorial($label, $description);
        $this->validateShape($durationMinutes, 0, 0);

        return $this->images->withImageReference(
            $imageSrc,
            fn (): BookableService => $this->database->transactional(function () use (
                $key,
                $expectedUpdatedAt,
                $label,
                $description,
                $durationMinutes,
                $imageSrc,
            ): BookableService {
                $this->serialization->acquire();
                $current = $this->lockedCurrent($key, $expectedUpdatedAt);
                $this->database->run(
                    'UPDATE booking_services SET booking_label = :label, description = :description,'
                    . ' image_src = :image, duration_minutes = :duration, updated_at = :updated'
                    . ' WHERE service_key = :service_key',
                    [
                        'label' => $label,
                        'description' => $description,
                        'image' => $imageSrc,
                        'duration' => $durationMinutes,
                        'updated' => $this->nextUpdatedAt($current),
                        'service_key' => $key,
                    ],
                );

                return $this->stored($key);
            }),
        );
    }

    /**
     * Archives (`false`) or restores (`true`) one service under its token
     * (ESZ-149). Non-destructive by construction: only `is_active` and
     * `updated_at` change, so historical bookings keep a resolvable key.
     */
    public function setActive(string $key, string $expectedUpdatedAt, bool $active): BookableService
    {
        return $this->database->transactional(function () use ($key, $expectedUpdatedAt, $active): BookableService {
            $this->serialization->acquire();
            $current = $this->lockedCurrent($key, $expectedUpdatedAt);
            $this->database->run(
                'UPDATE booking_services SET is_active = :active, updated_at = :updated'
                . ' WHERE service_key = :service_key',
                [
                    'active' => $active ? 1 : 0,
                    'updated' => $this->nextUpdatedAt($current),
                    'service_key' => $key,
                ],
            );

            return $this->stored($key);
        });
    }

    /**
     * Creates or refreshes the operator-provisioned facts of one stable key
     * (ESZ-041): duration, both buffers and activity.
     *
     * Since ESZ-149 the catalog row is the authority for its editorial facts.
     * The label, description and image are therefore *creation* inputs only:
     * they name and seed a new row (the CLI takes them from `--label` or the
     * published SiteContent item of the same key; a fresh row with nothing
     * to seed gets an empty description and no image — never a fabricated
     * value). An existing row keeps its stored name, description and image
     * whatever the caller passes; renaming is the admin mutation's business.
     *
     * Provisioning rewrites exactly the facts a slot validation reads —
     * `is_active`, duration and both buffers — so it takes the booking
     * serialization boundary first, inside its transaction (ESZ-146).
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
        ?string $description = null,
        ?string $imageSrc = null,
    ): array {
        $label = trim($label);
        if (!$this->contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Malformed service key.');
        }
        $this->validateEditorial($label, $description ?? '');
        $this->validateShape($durationMinutes, $bufferBeforeMinutes, $bufferAfterMinutes);

        return $this->images->withImageReference(
            $imageSrc,
            fn (): array => $this->database->transactional(function () use (
                $key,
                $label,
                $durationMinutes,
                $bufferBeforeMinutes,
                $bufferAfterMinutes,
                $active,
                $description,
                $imageSrc,
            ): array {
                $this->serialization->acquire();
                $existing = $this->find($key);
                $now = $this->clock->nowIso();

                if ($existing === null) {
                    $this->insert(
                        $key,
                        $label,
                        trim($description ?? ''),
                        $imageSrc,
                        $durationMinutes,
                        $bufferBeforeMinutes,
                        $bufferAfterMinutes,
                        $active,
                        $now,
                    );
                } else {
                    // Operational facts only: booking_label, description and
                    // image_src are admin-owned and never touched here.
                    $this->database->run(
                        'UPDATE booking_services SET duration_minutes = :duration,'
                        . ' buffer_before_minutes = :before, buffer_after_minutes = :after,'
                        . ' is_active = :active, updated_at = :updated WHERE service_key = :service_key',
                        [
                            'duration' => $durationMinutes,
                            'before' => $bufferBeforeMinutes,
                            'after' => $bufferAfterMinutes,
                            'active' => $active ? 1 : 0,
                            'updated' => $now,
                            'service_key' => $key,
                        ],
                    );
                }

                return ['service' => $this->stored($key), 'created' => $existing === null];
            }),
        );
    }

    /**
     * The row under `SELECT ... FOR UPDATE`, after the token comparison. The
     * caller already holds the serialization boundary, so the lock order is
     * the single frozen one: boundary, then the service row.
     */
    private function lockedCurrent(string $key, string $expectedUpdatedAt): BookableService
    {
        if (!$this->contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Malformed service key.');
        }

        $row = $this->database->fetchOne(
            'SELECT ' . self::COLUMNS . ' FROM booking_services WHERE service_key = :service_key FOR UPDATE',
            ['service_key' => $key],
        );
        if ($row === null) {
            throw new BookableServiceNotFoundException($key);
        }

        $current = BookableService::fromRow($row);
        if ($current->updatedAt !== $expectedUpdatedAt) {
            throw new BookableServiceRevisionConflictException($key, $expectedUpdatedAt, $current->updatedAt);
        }

        return $current;
    }

    /**
     * The next token: the application clock when it is strictly later than
     * the row's own token, otherwise the token plus one millisecond — so a
     * frozen or backward clock still mints a strictly newer `updatedAt` and
     * a consumed token can never be replayed (the ESZ-139 rule, applied to
     * catalog rows).
     */
    private function nextUpdatedAt(BookableService $current): string
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
            throw new \RuntimeException('The stored booking_services updated_at is not a canonical timestamp.');
        }

        return IsoTimestamp::format($stored->modify('+1 millisecond'));
    }

    private function insert(
        string $key,
        string $label,
        string $description,
        ?string $imageSrc,
        int $duration,
        int $before,
        int $after,
        bool $active,
        string $now,
    ): void {
        $this->database->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, description, image_src, duration_minutes,'
            . ' buffer_before_minutes, buffer_after_minutes, is_active, created_at, updated_at)'
            . ' VALUES (:service_key, :label, :description, :image, :duration, :before, :after,'
            . ' :active, :created, :updated)',
            [
                'service_key' => $key,
                'label' => $label,
                'description' => $description,
                'image' => $imageSrc,
                'duration' => $duration,
                'before' => $before,
                'after' => $after,
                'active' => $active ? 1 : 0,
                'created' => $now,
                'updated' => $now,
            ],
        );
    }

    private function stored(string $key): BookableService
    {
        $stored = $this->find($key);
        if ($stored === null) {
            throw new \RuntimeException('The bookable service disappeared during its own write.');
        }

        return $stored;
    }

    /**
     * A stable key from a name: lowercase ASCII, accents folded, every other
     * run of characters collapsed to one hyphen, bounded to the frozen shape,
     * then de-duplicated against the catalog with `-2`, `-3`, … The caller
     * holds the serialization boundary, so the probe and the insert cannot
     * interleave with another create.
     */
    private function deriveKey(string $label): string
    {
        $stem = self::slug($label);
        if ($stem === '' || !$this->contract->acceptsServiceKey($stem)) {
            $stem = self::FALLBACK_KEY_STEM;
        }

        $candidate = $stem;
        for ($suffix = 2; $this->find($candidate) !== null; $suffix++) {
            $tail = '-' . $suffix;
            $candidate = substr($stem, 0, 64 - \strlen($tail)) . $tail;
        }

        return $candidate;
    }

    private static function slug(string $label): string
    {
        $folded = strtr(mb_strtolower($label), [
            'à' => 'a', 'á' => 'a', 'â' => 'a', 'ä' => 'a', 'ã' => 'a', 'å' => 'a',
            'ç' => 'c', 'è' => 'e', 'é' => 'e', 'ê' => 'e', 'ë' => 'e',
            'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i', 'ñ' => 'n',
            'ò' => 'o', 'ó' => 'o', 'ô' => 'o', 'ö' => 'o', 'õ' => 'o', 'ø' => 'o',
            'ù' => 'u', 'ú' => 'u', 'û' => 'u', 'ü' => 'u', 'ý' => 'y', 'ÿ' => 'y',
            'œ' => 'oe', 'æ' => 'ae', 'ß' => 'ss',
        ]);
        $ascii = (string) preg_replace('/[^a-z0-9]+/', '-', $folded);
        $trimmed = trim($ascii, '-');
        // The shape requires a leading letter: drop a leading digit run.
        $trimmed = (string) preg_replace('/^[0-9-]+/', '', $trimmed);

        return rtrim(substr($trimmed, 0, 64), '-');
    }

    private function validateEditorial(string $label, string $description): void
    {
        if ($label === '' || mb_strlen($label) > $this->contract->labelMaxLength) {
            throw new BookingValidationException('bookingLabel', 'Booking label is empty or too long.');
        }
        if (mb_strlen(trim($description)) > $this->contract->descriptionMaxLength) {
            throw new BookingValidationException('description', 'Service description is too long.');
        }
    }

    private function validateShape(int $duration, int $before, int $after): void
    {
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
