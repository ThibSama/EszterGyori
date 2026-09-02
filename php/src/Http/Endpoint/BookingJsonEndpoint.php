<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Booking\BookingApi;
use Eszter\Booking\BookingNotFoundException;
use Eszter\Booking\BookingValidationException;
use Eszter\Booking\AvailabilityRevisionConflictException;
use Eszter\Booking\InvalidBookingTransitionException;
use Eszter\Booking\SlotUnavailableException;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Support\Logger;

/** Shared strict JSON and opaque-error boundary for every booking route. */
abstract class BookingJsonEndpoint
{
    public function __construct(
        protected readonly BookingApi $booking,
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
            throw new HttpException(400, \Eszter\Http\ErrorCatalog::INVALID_JSON, $this->headers());
        }

        /** @var array<string, mixed> $decoded */
        $issues = $this->structural->validate($decoded, $schema);
        if ($issues !== []) {
            $this->logger->warn('Booking body failed structural validation.', [
                'schema' => $schema,
                'issues' => \count($issues),
            ]);
            throw new HttpException(400, \Eszter\Http\ErrorCatalog::VALIDATION_FAILED, $this->headers());
        }

        return $decoded;
    }

    /**
     * @param \Closure(): array<string, mixed> $operation
     */
    final protected function response(int $status, \Closure $operation): Response
    {
        try {
            return Response::json($status, $operation(), $this->headers());
        } catch (AvailabilityRevisionConflictException $exception) {
            $this->logger->info(
                'Availability write refused: the schedule moved under the caller.',
                $exception->logContext(),
            );
            throw new HttpException(
                409,
                \Eszter\Http\ErrorCatalog::REVISION_CONFLICT,
                $this->headers(),
                $exception->getMessage(),
            );
        } catch (SlotUnavailableException $exception) {
            throw HttpException::slotUnavailable($this->headers(), $exception->getMessage());
        } catch (BookingNotFoundException $exception) {
            throw new HttpException(
                404,
                \Eszter\Http\ErrorCatalog::NOT_FOUND,
                $this->headers(),
                $exception->getMessage(),
            );
        } catch (BookingValidationException | InvalidBookingTransitionException $exception) {
            throw new HttpException(
                400,
                \Eszter\Http\ErrorCatalog::VALIDATION_FAILED,
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
