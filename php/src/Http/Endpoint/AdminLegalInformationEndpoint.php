<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Legal\LegalInformationApi;
use Eszter\Support\Logger;

/**
 * The authenticated half of the legal surface: session first, then CSRF for
 * the state-changing verb, exactly as {@see AdminBookingEndpoint} orders it.
 */
abstract class AdminLegalInformationEndpoint extends LegalJsonEndpoint
{
    public const PATH = '/api/admin/settings/legal';

    public function __construct(
        LegalInformationApi $legal,
        StructuralValidator $structural,
        Logger $logger,
        private readonly Authenticator $auth,
        private readonly SessionManager $sessions,
        private readonly CsrfGuard $csrf,
    ) {
        parent::__construct($legal, $structural, $logger);
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
