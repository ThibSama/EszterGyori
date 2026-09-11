<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-152 — pauses, unavailability, closures and leave.
 *
 * The same shape as the exceptions route: a PATCH carrying its action (create,
 * update, remove), so the three edits to one collection stay one route with
 * one closed discriminated union. It is its own route rather than more
 * actions on `/exceptions` because a constraint is addressed by id and may
 * span several dates, while an exception is — and is the whole of — one date.
 */
final class AdminAvailabilityConstraintsEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/availability/constraints';

    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody(
            $request,
            'admin-availability-constraint-mutation-request.schema.json',
        );

        return $this->response(
            200,
            fn (): array => $this->booking->adminMutateAvailabilityConstraint($body),
        );
    }
}
