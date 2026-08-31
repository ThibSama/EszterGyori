<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/** Read-only active service discovery for the public reservation flow. */
final class PublicBookableServicesEndpoint extends BookingJsonEndpoint
{
    public const PATH = '/api/booking/services';

    public function __invoke(Request $request): Response
    {
        return $this->response(200, fn (): array => $this->booking->services());
    }
}
