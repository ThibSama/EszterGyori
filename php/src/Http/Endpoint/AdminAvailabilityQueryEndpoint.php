<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-063/064 — reading the stored schedule.
 *
 * The public availability route exposes computed slots; this one exposes the
 * rules behind them, which is a different thing and an authenticated one.
 */
final class AdminAvailabilityQueryEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/availability/query';

    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-availability-query-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminAvailability($body));
    }
}
