<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

final class AdminBookingsQueryEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/bookings/query';

    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-bookings-query-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminQuery($body));
    }
}
