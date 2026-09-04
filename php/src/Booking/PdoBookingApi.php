<?php

declare(strict_types=1);

namespace Eszter\Booking;

use Eszter\Database\Database;
use Eszter\Notification\BookingNotificationProducer;
use Eszter\Notification\DurableBookingNotificationProducer;
use Eszter\Notification\NotificationCatchUpPolicy;
use Eszter\Notification\NotificationChannelSettings;
use Eszter\Notification\NotificationJobRepository;
use Eszter\Notification\NotificationPolicy;
use Eszter\Notification\NotificationScheduler;
use Eszter\Support\Clock;

/**
 * The booking application service (ESZ-106): a thin compatibility façade.
 *
 * Since ESZ-105 the routes and the HTTP contract depend only on
 * {@see BookingApi}; this class keeps implementing that interface unchanged
 * while delegating each use case to one concrete collaborator, all wired by
 * {@see createDefault()}:
 *
 * - {@see BookingServiceCatalog} — public service discovery and the single
 *   "actively bookable service" rule;
 * - {@see SlotAvailability} — public and move-availability reads, the public
 *   horizon/window rules and transactional slot revalidation;
 * - {@see BookingLifecycle} — the atomic create/update/move/cancel commands
 *   (locks, stale-token refusal, history and notification scheduling);
 * - {@see BookingAdminReader} — admin query/summary reads and their bounds;
 * - {@see AvailabilityAdministration} — availability editor reads and
 *   revision-protected schedule writes.
 *
 * The class owns no domain rule of its own; it only routes. MySQL-owned
 * concurrency control stays in {@see BookingSerializationLock} and the
 * repositories.
 */
final class PdoBookingApi implements BookingApi
{
    public function __construct(
        private readonly BookingServiceCatalog $serviceCatalog,
        private readonly SlotAvailability $slotAvailability,
        private readonly BookingLifecycle $lifecycle,
        private readonly BookingAdminReader $adminReader,
        private readonly AvailabilityAdministration $availabilityAdministration,
    ) {
    }

    public static function createDefault(
        Database $database,
        Clock $clock,
        BookingDomainContract $contract,
        NotificationPolicy $notificationPolicy,
        ?BookingNotificationProducer $notificationProducer = null,
    ): self {
        $time = new BookingTimePolicy($contract);
        $serialization = new BookingSerializationLock($database);
        $services = new BookableServiceRepository($database, $clock, $contract, $serialization);
        $bookings = new BookingRepository(
            $database,
            $clock,
            $contract,
            $time,
            $services,
            new BookingStateMachine($contract),
        );

        $jobs = new NotificationJobRepository($database, $clock, $notificationPolicy);
        $scheduler = new NotificationScheduler(
            $jobs,
            new NotificationCatchUpPolicy(
                new NotificationChannelSettings($database, $clock, $notificationPolicy),
                $notificationPolicy,
                $clock,
            ),
        );

        $availabilityRepository = new AvailabilityRepository($database, $clock, $contract, $time, $serialization);
        $history = new BookingHistoryRepository($database, $clock);

        $catalog = new BookingServiceCatalog($services);
        $availability = new SlotAvailability(
            $contract,
            $time,
            $clock,
            $catalog,
            $availabilityRepository,
            $bookings,
            new SlotEngine($contract, $time),
        );

        return new self(
            $catalog,
            $availability,
            new BookingLifecycle(
                $database,
                $contract,
                $time,
                $clock,
                $serialization,
                $availability,
                $bookings,
                $history,
                $notificationProducer ?? new DurableBookingNotificationProducer($scheduler, $jobs, $clock),
            ),
            new BookingAdminReader($contract, $time, $clock, $availability, $bookings, $history),
            new AvailabilityAdministration($contract, $availabilityRepository),
        );
    }

    /** @inheritDoc */
    public function services(): array
    {
        return $this->serviceCatalog->services();
    }

    /** @inheritDoc */
    public function availability(array $request): array
    {
        return $this->slotAvailability->availability($request);
    }

    /** @inheritDoc */
    public function create(array $request): array
    {
        return $this->lifecycle->create($request);
    }

    /** @inheritDoc */
    public function adminQuery(array $request): array
    {
        return $this->adminReader->adminQuery($request);
    }

    /** @inheritDoc */
    public function adminMoveAvailability(array $request): array
    {
        return $this->slotAvailability->adminMoveAvailability($request);
    }

    /** @inheritDoc */
    public function adminMutate(array $request): array
    {
        return $this->lifecycle->adminMutate($request);
    }

    /** @inheritDoc */
    public function adminSummary(array $request): array
    {
        return $this->adminReader->adminSummary($request);
    }

    /** @inheritDoc */
    public function adminAvailability(array $request): array
    {
        return $this->availabilityAdministration->adminAvailability($request);
    }

    /** @inheritDoc */
    public function adminReplaceWeeklyAvailability(array $request): array
    {
        return $this->availabilityAdministration->adminReplaceWeeklyAvailability($request);
    }

    /** @inheritDoc */
    public function adminMutateAvailabilityException(array $request): array
    {
        return $this->availabilityAdministration->adminMutateAvailabilityException($request);
    }
}
