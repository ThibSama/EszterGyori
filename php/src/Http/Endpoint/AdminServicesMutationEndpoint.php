<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-149 — create, update, archive and restore on the service catalog.
 *
 * A PATCH carrying its action, like the availability exceptions and the
 * booking mutations: all four are edits to one collection, and the closed
 * discriminated union is what keeps "archive" an explicit act rather than a
 * boolean a stale form could flip back by accident. There is no DELETE: a
 * service row is never removed.
 */
final class AdminServicesMutationEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/services';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-service-mutation-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminMutateService($body));
    }
}
