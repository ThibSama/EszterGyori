<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-064 — closures, exceptional openings and removals.
 *
 * A PATCH carrying its action, rather than three routes or a DELETE with a body:
 * all three are edits to one date's entry in one collection, and the closed
 * discriminated union is what makes "close" and "open with no windows" different
 * requests instead of the same one arrived at by accident.
 */
final class AdminAvailabilityExceptionsEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/availability/exceptions';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody(
            $request,
            'admin-availability-exception-mutation-request.schema.json',
        );

        return $this->response(
            200,
            fn (): array => $this->booking->adminMutateAvailabilityException($body),
        );
    }
}
