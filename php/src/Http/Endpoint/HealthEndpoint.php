<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Contract\ContractArtifacts;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Support\Clock;

/**
 * `GET /api/health` (ESZ-013).
 *
 * ## It reads nothing
 *
 * The handler touches no file, takes no lock and never asks storage a question.
 * That is the `health.doesNotDependOnContentStorage` invariant, and it is the
 * whole point of the endpoint: health answers "is this service able to respond",
 * and folding "is the published content valid" into that answer would make an
 * editor's bad publish look like an outage to every monitor watching the host.
 * Content problems surface on `/api/content` as the 500 the contract already
 * freezes for them.
 *
 * This is also what keeps `/api/health` honest about its frozen statuses — 200,
 * 400 and 405, with no 500. A boot failure can still answer 500 on this path, but
 * that is bootstrap failing before any route is reached, which the contract
 * states separately (`bootstrapFailure`) precisely so it is not read as a failure
 * mode of health itself.
 *
 * ## No `uptimeSeconds`
 *
 * Removed from the contract in Package 1.2. Every PHP request is its own process,
 * so there is no uptime to report and nothing here invents one. See
 * `contracts/http-contract.ts`.
 */
final class HealthEndpoint
{
    public const PATH = '/api/health';

    public function __construct(
        private readonly ContractArtifacts $artifacts,
        private readonly Clock $clock,
        private readonly string $serviceName,
    ) {
    }

    /**
     * The service name is read from the generated health schema's `const` rather
     * than retyped, for the same reason the error copy is: a literal here is a
     * second source of truth that nothing would catch drifting.
     */
    public static function fromArtifacts(ContractArtifacts $artifacts, Clock $clock): self
    {
        $schema = $artifacts->schema('health-response.schema.json');
        /** @var mixed $properties */
        $properties = $schema['properties'] ?? null;
        /** @var mixed $service */
        $service = \is_array($properties) ? ($properties['service'] ?? null) : null;
        /** @var mixed $constant */
        $constant = \is_array($service) ? ($service['const'] ?? null) : null;

        if (!\is_string($constant)) {
            throw new \RuntimeException('health-response.schema.json declares no service const.');
        }

        return new self($artifacts, $clock, $constant);
    }

    public function __invoke(Request $request): Response
    {
        return Response::json(200, [
            'status' => 'ok',
            'service' => $this->serviceName,
            'contentSchemaVersion' => $this->artifacts->contentSchemaVersion(),
            'timestamp' => $this->clock->nowIso(),
        ]);
    }
}
