<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-063 — replacing the weekly schedule.
 *
 * A PUT, because the body is the complete intended week and the route replaces
 * the resource with it. That shape is the atomicity guarantee: there is one
 * request to fail, so a failure leaves the previously stored schedule rather
 * than however far a sequence of per-row calls happened to get.
 */
final class AdminAvailabilityWeeklyEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/availability/weekly';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-availability-weekly-replace-request.schema.json');

        return $this->response(
            200,
            fn (): array => $this->booking->adminReplaceWeeklyAvailability($body),
        );
    }
}
