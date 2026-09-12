<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Contract\StructuralValidator;
use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Legal\LegalInformationApi;
use Eszter\Legal\LegalInformationRevisionConflictException;
use Eszter\Support\Logger;

/**
 * ESZ-165 — the strict-JSON and opaque-error boundary shared by the legal
 * routes, the shape {@see BookingJsonEndpoint} gives the booking surface.
 *
 * `Cache-Control: no-store` on every answer: the public document changes
 * without a deploy when the administrator saves it, and a legal page served
 * from a cache would keep publishing what was corrected.
 */
abstract class LegalJsonEndpoint
{
    public function __construct(
        protected readonly LegalInformationApi $legal,
        protected readonly StructuralValidator $structural,
        protected readonly Logger $logger,
    ) {
    }

    /** @return array<string, mixed> */
    final protected function validatedBody(Request $request, string $schema): array
    {
        /** @var mixed $decoded */
        $decoded = json_decode($request->rawBody, true);
        if (!\is_array($decoded) || json_last_error() !== JSON_ERROR_NONE) {
            throw new HttpException(400, ErrorCatalog::INVALID_JSON, $this->headers());
        }

        /** @var array<string, mixed> $decoded */
        $issues = $this->structural->validate($decoded, $schema);
        if ($issues !== []) {
            $this->logger->warn('Legal information body failed structural validation.', [
                'schema' => $schema,
                'issues' => \count($issues),
            ]);
            throw new HttpException(400, ErrorCatalog::VALIDATION_FAILED, $this->headers());
        }

        return $decoded;
    }

    /** @param \Closure(): array<string, mixed> $operation */
    final protected function response(int $status, \Closure $operation): Response
    {
        try {
            return Response::json($status, $operation(), $this->headers());
        } catch (LegalInformationRevisionConflictException $exception) {
            $this->logger->info(
                'Legal information save refused: the document moved under the caller.',
                $exception->logContext(),
            );
            throw new HttpException(
                409,
                ErrorCatalog::REVISION_CONFLICT,
                $this->headers(),
                $exception->getMessage(),
            );
        }
    }

    /** @return array<string, string> */
    final protected function headers(): array
    {
        return ['Cache-Control' => 'no-store'];
    }
}
