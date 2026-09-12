<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-164 — executes one right against a recorded GDPR request.
 *
 * Every action is a state change (an export closes the record; the others
 * write bookings): session then CSRF before the body is parsed. The strict
 * schema is what keeps the destructive confirmation on the wire and a
 * foreign booking reference out of a rectification.
 */
final class AdminPrivacyRequestActionsEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/privacy-requests/actions';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-privacy-request-action-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminExecutePrivacyRequestAction($body));
    }
}
