<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

final class AdminBookingMoveAvailabilityEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/bookings/move-availability';

    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-booking-move-availability-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminMoveAvailability($body));
    }
}
