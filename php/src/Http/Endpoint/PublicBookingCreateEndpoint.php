<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

final class PublicBookingCreateEndpoint extends BookingJsonEndpoint
{
    public const PATH = '/api/bookings';

    public function __invoke(Request $request): Response
    {
        $body = $this->validatedBody($request, 'public-booking-create-request.schema.json');

        return $this->response(201, fn (): array => $this->booking->create($body));
    }
}
