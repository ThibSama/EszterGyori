<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * ESZ-163 — the GDPR requester's scope search.
 *
 * A read, so it needs a session and no CSRF, for the same reason the booking
 * query does: it changes nothing. It resolves one booking by reference or
 * one page of a customer e-mail's live bookings; it stores nothing.
 */
final class AdminPrivacyRequestSearchEndpoint extends AdminBookingEndpoint
{
    public const PATH = '/api/admin/privacy-requests/search';

    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        $body = $this->validatedBody($request, 'admin-privacy-request-search-request.schema.json');

        return $this->response(200, fn (): array => $this->booking->adminPrivacyRequestSearch($body));
    }
}
