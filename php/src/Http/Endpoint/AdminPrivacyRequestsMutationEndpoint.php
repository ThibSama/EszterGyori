<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-163 — records one reviewed GDPR request.
 *
 * The register's only write, and a state change: session then CSRF before
 * the body is parsed. It writes the register and nothing else.
 */
final class AdminPrivacyRequestsMutationEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/privacy-requests';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-privacy-request-create-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminRecordPrivacyRequest($body));
    }
}
