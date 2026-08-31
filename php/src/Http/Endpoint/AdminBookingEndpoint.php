<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;
use Eszter\Booking\BookingApi;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Support\Logger;

abstract class AdminBookingEndpoint extends BookingJsonEndpoint
{
    public function __construct(
        BookingApi $booking,
        StructuralValidator $structural,
        Logger $logger,
        private readonly Authenticator $auth,
        private readonly SessionManager $sessions,
        private readonly CsrfGuard $csrf,
    ) {
        parent::__construct($booking, $structural, $logger);
    }

    abstract protected function isStateChanging(): bool;

    abstract protected function handle(Request $request): Response;

    final public function __invoke(Request $request): Response
    {
        $this->auth->requireAccount();
        if ($this->isStateChanging()) {
            $session = $this->sessions->current();
            if ($session === null) {
                throw HttpException::unauthenticated();
            }
            $this->csrf->assert($request, $session);
        }

        return $this->handle($request);
    }
}
