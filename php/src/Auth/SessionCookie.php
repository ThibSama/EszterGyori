<?php

declare(strict_types=1);

namespace Eszter\Auth;

use Eszter\Contract\ContractArtifacts;
use Eszter\Http\Request;

/**
 * The session cookie, rendered and parsed from the frozen contract (ESZ-025).
 *
 * Every attribute comes from `http-contract.json` → `auth.sessionCookie`. Only
 * `Secure` is a configuration value, and only because a developer on plain HTTP
 * cannot receive a `Secure` cookie at all; production is forbidden from turning
 * it off by {@see \Eszter\Config\Configuration}.
 *
 * ## The `__Host-` prefix, and the one place it bends
 *
 * `__Host-` makes the *browser* enforce what the attributes claim: it refuses the
 * cookie unless it is `Secure`, `Path=/` and carries no `Domain`. That removes a
 * whole class of attack in which a compromised or attacker-registered subdomain
 * writes a session cookie that the parent domain then accepts.
 *
 * It also means the prefixed name is unusable without `Secure`. Rather than
 * either breaking local development or quietly shipping a name whose guarantee is
 * not in force, {@see name()} drops the prefix exactly when `Secure` is off — so
 * the prefixed name is present if and only if the browser will actually enforce
 * it, and a non-production cookie cannot be replayed against production under the
 * name production trusts.
 */
final class SessionCookie
{
    private function __construct(
        private readonly string $contractName,
        private readonly bool $httpOnly,
        private readonly string $sameSite,
        private readonly string $path,
        private readonly bool $secure,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts, bool $secure): self
    {
        /** @var mixed $cookie */
        $cookie = $artifacts->authContract()['sessionCookie'] ?? null;

        if (!\is_array($cookie)) {
            throw new \RuntimeException('http-contract.json has no auth.sessionCookie block.');
        }

        /** @var mixed $name */
        $name = $cookie['name'] ?? null;
        /** @var mixed $httpOnly */
        $httpOnly = $cookie['httpOnly'] ?? null;
        /** @var mixed $sameSite */
        $sameSite = $cookie['sameSite'] ?? null;
        /** @var mixed $path */
        $path = $cookie['path'] ?? null;

        if (!\is_string($name) || !\is_bool($httpOnly) || !\is_string($sameSite) || !\is_string($path)) {
            throw new \RuntimeException('http-contract.json auth.sessionCookie is malformed.');
        }

        // `domain` is contractually null and there is no code to emit one. Asserted
        // rather than read, so that a contract change adding a Domain fails loudly
        // here instead of being silently ignored — a Domain attribute would widen
        // the cookie to every subdomain and void the __Host- guarantee.
        if (($cookie['domain'] ?? null) !== null) {
            throw new \RuntimeException(
                'http-contract.json declares a cookie Domain; the session cookie must be host-only.',
            );
        }

        return new self($name, $httpOnly, $sameSite, $path, $secure);
    }

    /** The name actually sent. See the class note on `__Host-`. */
    public function name(): string
    {
        if ($this->secure) {
            return $this->contractName;
        }

        return str_starts_with($this->contractName, '__Host-')
            ? substr($this->contractName, 7)
            : $this->contractName;
    }

    /** The session id the request carries, or null. */
    public function read(Request $request): ?string
    {
        $header = $request->header('cookie');

        if ($header === null) {
            return null;
        }

        $name = $this->name();

        foreach (explode(';', $header) as $pair) {
            $equals = strpos($pair, '=');

            if ($equals === false) {
                continue;
            }

            if (trim(substr($pair, 0, $equals)) !== $name) {
                continue;
            }

            $value = trim(substr($pair, $equals + 1));

            // Only the shape PHP's session id generator produces is accepted. A
            // value with any other byte in it never reaches session_id(), so a
            // crafted cookie cannot reach the save handler's parameters or PHP's
            // own id validation at all.
            return preg_match('/^[A-Za-z0-9,-]{22,128}$/', $value) === 1 ? $value : null;
        }

        return null;
    }

    public function set(string $sessionId): string
    {
        return $this->render($sessionId, []);
    }

    /**
     * A cookie that expires the current one.
     *
     * Both `Max-Age` and `Expires` are sent: `Max-Age` is what modern browsers
     * honour, `Expires` is what a proxy or an old client honours, and a client
     * that keeps the cookie anyway gains nothing because logout has already
     * deleted the server-side record.
     */
    public function clear(): string
    {
        return $this->render('', ['Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    }

    /** @param list<string> $extra */
    private function render(string $value, array $extra): string
    {
        $parts = [$this->name() . '=' . $value, 'Path=' . $this->path];

        foreach ($extra as $attribute) {
            $parts[] = $attribute;
        }

        if ($this->secure) {
            $parts[] = 'Secure';
        }

        if ($this->httpOnly) {
            $parts[] = 'HttpOnly';
        }

        $parts[] = 'SameSite=' . $this->sameSite;

        return implode('; ', $parts);
    }
}
