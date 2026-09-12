<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Http\Request;
use Eszter\Http\Response;

/**
 * `GET /api/legal` — the stored legal document, readable by anyone (ESZ-165).
 *
 * `/mentions-legales` and `/confidentialite` are static exports that read
 * this at load, the way `/reservation` reads the catalog, so a save in the
 * admin is visible on the next page load with no rebuild. What is shown is
 * the page's decision (`publicLegalFacts` in the contract): this answers the
 * document as stored, unset facts included, and never a warning.
 */
final class PublicLegalInformationEndpoint extends LegalJsonEndpoint
{
    public const PATH = '/api/legal';

    public function __invoke(Request $request): Response
    {
        return $this->response(200, fn (): array => $this->legal->read());
    }
}
