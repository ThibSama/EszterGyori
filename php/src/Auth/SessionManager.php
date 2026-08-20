<?php

declare(strict_types=1);

namespace Eszter\Auth;

use Eszter\Config\SessionSettings;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Support\Clock;
use Eszter\Support\IsoTimestamp;

/**
 * The session lifecycle for one request (ESZ-025).
 *
 * ## Why this is not `session_start()`
 *
 * PHP's own session extension was the obvious first choice and it does not fit
 * this application. Two reasons, in order of weight:
 *
 *  1. **It is global state in a codebase built to have none.** `Request` exists
 *     because the HTTP layer is "decoupled from PHP superglobals so the whole HTTP
 *     layer is testable without a web server", and `Response` is built in memory
 *     and only then written out. `session_start()` reads a superglobal, writes
 *     headers directly, and keeps its state in another superglobal — it would
 *     reintroduce precisely what the rest of this layer removed, and the
 *     `Set-Cookie` it emits would bypass `Response` entirely.
 *  2. **It cannot be exercised.** `session_start()`, `session_id()` and
 *     `session_regenerate_id()` all refuse once `headers_sent()` is true, and
 *     under the CLI SAPI that becomes true after the first byte the test runner
 *     prints. Rotation-on-login and logout invalidation are the two properties
 *     most worth proving, and with the extension they are the two that cannot be.
 *
 * What the extension would have provided — an opaque random id, a server-side
 * record, strict rejection of client-chosen ids, rotation on privilege change —
 * is provided here instead, and none of it is subtle: it is the four methods
 * below. `docs/hetzner-target-architecture.md` §6 asks for "PHP session: opaque
 * random id, server-side record in MySQL", which is what this is.
 *
 * ## Client-chosen ids are never adopted
 *
 * {@see load()} looks the incoming id up and keeps it only if it names a live
 * row. An unknown id is discarded and a fresh one is minted, so an attacker who
 * plants `Cookie: …=known-value` in a victim's browser ends up with a session id
 * they do not know. This is the equivalent of `session.use_strict_mode=1`, made
 * unconditional because there is no reason to ever want the other behaviour.
 */
final class SessionManager
{
    private ?Session $session = null;

    /** The id the request arrived with, live or not. */
    private ?string $incomingId = null;

    private bool $cookieMustBeSet = false;
    private bool $cookieMustBeCleared = false;

    public function __construct(
        private readonly SessionStore $store,
        private readonly SessionCookie $cookie,
        private readonly SessionSettings $settings,
        private readonly Clock $clock,
    ) {
    }

    /**
     * Resolves the request's session, if it has a live one.
     *
     * Creates nothing: a request to the public surface must not cost a session
     * row. {@see ensure()} is what creates one, and only the auth endpoints call
     * it.
     */
    public function load(Request $request): void
    {
        // Reset first. On the target runtime each request is its own process and
        // this would be redundant, but `Kernel::handle()` is also called several
        // times against one kernel — by the test suites, and by any future runner
        // that keeps a process alive — and a `cookieMustBeSet` left over from a
        // previous request would attach a `Set-Cookie` to a response that must not
        // carry one. That is exactly the mistake
        // `auth.failureModesAreIndistinguishable` exists to catch, and it caught
        // this one.
        $this->session = null;
        $this->cookieMustBeSet = false;
        $this->cookieMustBeCleared = false;

        $this->incomingId = $this->cookie->read($request);

        if ($this->incomingId === null) {
            return;
        }

        $found = $this->store->find($this->incomingId);

        if ($found === null) {
            // Unknown, expired, or simply invented. In every case it is not
            // adopted; the next ensure() mints a new id.
            return;
        }

        $this->session = $this->touch($found);
    }

    /** The live session for this request, or null. */
    public function current(): ?Session
    {
        return $this->session;
    }

    /** The live session, creating an anonymous one if there is none. */
    public function ensure(): Session
    {
        if ($this->session !== null) {
            return $this->session;
        }

        return $this->session = $this->create(null);
    }

    /**
     * Replaces the current session with a new one under a new id.
     *
     * Called on successful login and nowhere else. The old row is deleted first,
     * so the pre-login id confers nothing afterwards, and the new session gets a
     * new CSRF token as well — a token captured before the privilege change is as
     * useless as the id it was bound to.
     */
    public function rotate(int $accountId): Session
    {
        $previous = $this->session === null ? $this->incomingId : $this->session->id;

        if ($previous !== null) {
            $this->store->destroy($previous);
        }

        return $this->session = $this->create($accountId);
    }

    /**
     * Ends the session server-side.
     *
     * The order matters and is the reverse of the intuitive one: the row goes
     * first, the cookie second. A client that ignores `Set-Cookie` — or an
     * attacker who captured the cookie earlier — then holds an id that names
     * nothing, which is the only form of logout that means anything. Expiring the
     * cookie is a courtesy to the browser, not the mechanism.
     */
    public function destroy(): void
    {
        $id = $this->session === null ? $this->incomingId : $this->session->id;

        if ($id !== null) {
            $this->store->destroy($id);
        }

        $this->session = null;
        $this->cookieMustBeSet = false;
        $this->cookieMustBeCleared = true;
    }

    /**
     * Re-binds the current session to an account, or to none.
     *
     * Used when a signed-in account turns out to be disabled: the session is not
     * destroyed — that would hide the fact that it existed — but it stops
     * authenticating anything.
     */
    public function detachAccount(): void
    {
        if ($this->session === null || !$this->session->isAuthenticated()) {
            return;
        }

        $this->session = $this->session->withAccount(null);
        $this->store->save($this->session);
    }

    /**
     * Adds `Set-Cookie` when, and only when, the id the client holds is no longer
     * the right one.
     *
     * Re-sending an unchanged cookie on every response would be harmless but
     * noisy; the contract's `sessionCookie: "absent"` expectations exist to catch
     * the opposite mistake, where a failed login or a rejected CSRF check quietly
     * hands out a new session anyway.
     */
    public function applyTo(Response $response): Response
    {
        if ($this->cookieMustBeCleared) {
            return $response->withHeader('Set-Cookie', $this->cookie->clear());
        }

        if ($this->cookieMustBeSet && $this->session !== null) {
            return $response->withHeader('Set-Cookie', $this->cookie->set($this->session->id));
        }

        return $response;
    }

    private function create(?int $accountId): Session
    {
        $now = $this->clock->now();

        $session = new Session(
            Session::newId(),
            $accountId,
            Session::newCsrfToken(),
            IsoTimestamp::format($now),
            IsoTimestamp::format($now),
            $this->deadline($now, $this->settings->idleTimeoutSeconds()),
            $this->deadline($now, $this->settings->absoluteLifetimeSeconds()),
        );

        $this->store->save($session);
        $this->cookieMustBeSet = true;
        $this->cookieMustBeCleared = false;

        return $session;
    }

    /**
     * Slides the idle deadline forward.
     *
     * The absolute deadline is untouched by construction — {@see Session::withDeadlines()}
     * carries it over and `PdoSessionStore::save()` never updates that column — so
     * using a session extends how long it may idle but never how long it may live.
     */
    private function touch(Session $session): Session
    {
        $now = $this->clock->now();

        $touched = $session->withDeadlines(
            IsoTimestamp::format($now),
            $this->deadline($now, $this->settings->idleTimeoutSeconds()),
        );

        $this->store->save($touched);

        return $touched;
    }

    private function deadline(\DateTimeImmutable $now, int $seconds): string
    {
        return IsoTimestamp::format($now->modify("+{$seconds} seconds"));
    }
}
