<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-149 — reading the whole service catalog: `GET /api/admin/services`.
 *
 * The public route exposes only active services; this one exposes every row,
 * archived included, because an archived service still names historical
 * bookings the back-office must render. An authenticated read, no CSRF and
 * no body — the same shape as the media library listing.
 */
final class AdminServicesQueryEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/services';

    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        return $this->response(200, fn (): array => $this->booking->adminServices());
    }
}
