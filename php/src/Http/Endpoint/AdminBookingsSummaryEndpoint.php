<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-065 — the operational summary.
 *
 * A read, so it needs a session and no CSRF, for the same reason
 * {@see AdminBookingsQueryEndpoint} does: it changes nothing, and requiring a
 * token on a read would only teach callers to send one everywhere.
 */
final class AdminBookingsSummaryEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/bookings/summary';

    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-bookings-summary-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminSummary($body));
    }
}
