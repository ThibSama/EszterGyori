<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

final class AdminBookingsMutationEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/bookings';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-booking-mutation-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminMutate($body));
    }
}
