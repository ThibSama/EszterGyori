<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `GET /api/admin/settings/legal` — the document with its revision and last
 * write, what the settings form starts from (ESZ-165). An authenticated
 * read, no CSRF and no body.
 */
final class AdminLegalInformationReadEndpoint extends AdminLegalInformationEndpoint
{
    protected function isStateChanging(): bool
    {
        return false;
    }

    protected function handle(Request $request): Response
    {
        return $this->response(200, fn (): array => $this->legal->adminRead());
    }
}
