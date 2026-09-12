<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `PUT /api/admin/settings/legal` — replaces the legal document whole under
 * the revision the administrator last read (ESZ-165).
 *
 * A PUT because the document is one resource read and replaced whole, the
 * shape the content draft already has. The body is checked against the
 * frozen strict schema before anything is touched: a malformed SIREN, a
 * number on a VAT declared not applicable, or a field outside the model is
 * refused rather than stored. A partial document — unknown facts left null —
 * is accepted: the server never fills a legal identifier in.
 */
final class AdminLegalInformationSaveEndpoint extends AdminLegalInformationEndpoint
{
    protected function isStateChanging(): bool
    {
        return true;
    }

    protected function handle(Request $request): Response
    {
        /** @var array{expectedRevision: int, information: array<string, mixed>} $body */
        $body = $this->validatedBody($request, 'admin-legal-information-save-request.schema.json');

        return $this->response(200, fn (): array => $this->legal->adminSave($body));
    }
}
