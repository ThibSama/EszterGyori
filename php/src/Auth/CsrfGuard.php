<?php

declare(strict_types=1);

namespace Eszter\Auth;

use Eszter\Contract\ContractArtifacts;
use Eszter\Http\HttpException;
use Eszter\Http\Request;

/**
 * The CSRF check (ESZ-026).
 *
 * ## Why `SameSite=Strict` is not enough on its own
 *
 * The session cookie carries `SameSite=Strict` and that genuinely stops the
 * classic cross-site form post. It is still not the mechanism, for three reasons:
 * it is a behaviour of the *browser* rather than a check by the server, so it
 * protects nothing against a non-browser client; a same-site subresource — an
 * injected script anywhere on the origin, or a lax sibling application sharing
 * it — is not cross-site at all and sails straight through; and user agents have
 * repeatedly relaxed `SameSite` defaults and edge cases under compatibility
 * pressure. A defence whose strength is decided by someone else's release notes
 * is a defence to have *in addition*, which is what the contract says.
 *
 * ## The token
 *
 * 256 bits, minted with the session, rotated whenever the session id rotates,
 * carried in a header the browser will not attach on its own. It is compared with
 * {@see hash_equals()}: a `===` on a secret leaks its prefix through timing, and
 * while exploiting that over a network is hard, writing the correct comparison is
 * not.
 *
 * The header is the only accepted channel. Not a query parameter — it would land
 * in access logs, `Referer` headers and browser history — and not a form field,
 * because nothing on this surface posts a form.
 */
final class CsrfGuard
{
    private function __construct(private readonly string $header)
    {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        /** @var mixed $csrf */
        $csrf = $artifacts->authContract()['csrf'] ?? null;
        /** @var mixed $header */
        $header = \is_array($csrf) ? ($csrf['header'] ?? null) : null;

        if (!\is_string($header) || $header === '') {
            throw new \RuntimeException('http-contract.json has no auth.csrf.header.');
        }

        return new self($header);
    }

    public function header(): string
    {
        return $this->header;
    }

    /**
     * Passes, or throws the frozen 403.
     *
     * Missing, empty, malformed and simply-wrong all end here with the same
     * exception. The distinction between them is only ever written to the log,
     * where the request id is what ties it to a caller.
     *
     * @throws HttpException 403 CSRF_TOKEN_INVALID
     */
    public function assert(Request $request, Session $session): void
    {
        $presented = $request->header($this->header);

        if ($presented === null) {
            throw HttpException::csrfTokenInvalid('No CSRF header on a state-changing request.');
        }

        $presented = trim($presented);

        if ($presented === '') {
            throw HttpException::csrfTokenInvalid('Empty CSRF header.');
        }

        if (!hash_equals($session->csrfToken, $presented)) {
            throw HttpException::csrfTokenInvalid('CSRF token does not match the session.');
        }
    }
}
