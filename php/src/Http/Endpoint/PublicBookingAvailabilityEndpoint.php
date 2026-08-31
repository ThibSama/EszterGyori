<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

final class PublicBookingAvailabilityEndpoint extends BookingJsonEndpoint
{
    public const PATH = '/api/booking/availability';

    public function __invoke(Request $request): Response
    {
        $body = $this->validatedBody($request, 'booking-availability-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->availability($body));
    }
}
