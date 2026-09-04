<?php

declare(strict_types=1);

namespace Eszter\Composition;

use Eszter\Booking\BookingApi;
use Eszter\Http\Endpoint\AdminAvailabilityExceptionsEndpoint;
use Eszter\Http\Endpoint\AdminAvailabilityQueryEndpoint;
use Eszter\Http\Endpoint\AdminAvailabilityWeeklyEndpoint;
use Eszter\Http\Endpoint\AdminBookingMoveAvailabilityEndpoint;
use Eszter\Http\Endpoint\AdminBookingsMutationEndpoint;
use Eszter\Http\Endpoint\AdminBookingsQueryEndpoint;
use Eszter\Http\Endpoint\AdminBookingsSummaryEndpoint;
use Eszter\Http\Endpoint\PublicBookableServicesEndpoint;
use Eszter\Http\Endpoint\PublicBookingAvailabilityEndpoint;
use Eszter\Http\Endpoint\PublicBookingCreateEndpoint;
use Eszter\Http\Router;

/**
 * Composes the whole booking surface, public and admin.
 *
 * The public half — service discovery, availability and creation — is
 * registered as soon as a booking implementation exists. The composition root
 * constructs this composer only when `$booking` is non-null, which mirrors the
 * frozen registration condition: without booking use cases these routes would
 * only ever answer 500, so they are not routed at all.
 *
 * The admin half — query, mutation, move-availability, summary and the
 * availability editor (ESZ-063/064/065) — is gated on the same condition as
 * every other admin surface: an authenticated session must exist. This
 * composer therefore receives the {@see AuthenticatedServices} bundle when the
 * root wired an authenticated surface and `null` otherwise, and registers the
 * admin routes only in the former case.
 */
final class BookingRoutes
{
    public function __construct(
        private readonly KernelServices $services,
        private readonly BookingApi $booking,
        private readonly ?AuthenticatedServices $auth = null,
    ) {
    }

    public function register(Router $router): void
    {
        $public = [$this->booking, $this->services->structural, $this->services->logger];

        $router->register(
            'GET',
            PublicBookableServicesEndpoint::PATH,
            new PublicBookableServicesEndpoint(...$public),
        );
        $router->register(
            'POST',
            PublicBookingAvailabilityEndpoint::PATH,
            new PublicBookingAvailabilityEndpoint(...$public),
        );
        $router->register(
            'POST',
            PublicBookingCreateEndpoint::PATH,
            new PublicBookingCreateEndpoint(...$public),
        );

        if ($this->auth === null) {
            return;
        }

        $admin = [
            $this->booking,
            $this->services->structural,
            $this->services->logger,
            $this->auth->authenticator,
            $this->auth->sessions,
            $this->auth->csrf,
        ];

        $router->register(
            'POST',
            AdminBookingsQueryEndpoint::PATH,
            new AdminBookingsQueryEndpoint(...$admin),
        );
        $router->register(
            'POST',
            AdminBookingMoveAvailabilityEndpoint::PATH,
            new AdminBookingMoveAvailabilityEndpoint(...$admin),
        );
        $router->register(
            'PATCH',
            AdminBookingsMutationEndpoint::PATH,
            new AdminBookingsMutationEndpoint(...$admin),
        );
        $router->register(
            'POST',
            AdminBookingsSummaryEndpoint::PATH,
            new AdminBookingsSummaryEndpoint(...$admin),
        );
        $router->register(
            'POST',
            AdminAvailabilityQueryEndpoint::PATH,
            new AdminAvailabilityQueryEndpoint(...$admin),
        );
        $router->register(
            'PUT',
            AdminAvailabilityWeeklyEndpoint::PATH,
            new AdminAvailabilityWeeklyEndpoint(...$admin),
        );
        $router->register(
            'PATCH',
            AdminAvailabilityExceptionsEndpoint::PATH,
            new AdminAvailabilityExceptionsEndpoint(...$admin),
        );
    }
}
