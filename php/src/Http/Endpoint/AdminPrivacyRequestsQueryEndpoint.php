<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/** ESZ-163 — the GDPR request register's history page and detail read. */
final class AdminPrivacyRequestsQueryEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/privacy-requests/query';

    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-privacy-requests-query-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminPrivacyRequests($body));
    }
}
