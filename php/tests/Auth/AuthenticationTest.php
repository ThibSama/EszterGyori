<?php

declare(strict_types=1);

namespace Eszter\Tests\Auth;

use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The auth invariants of `http-contract.json` (ESZ-025 / ESZ-026).
 *
 * `httpContractInvariants` is the list of frozen behaviour that "is not
 * expressible as a single request/response case", and it says each entry must
 * stay covered by a named test. These are the eight ESZ-025/026 added: every one
 * of them is a statement about what happens *between* two requests — a rotation,
 * an invalidation, a revocation — which is exactly why none of them fits a corpus
 * case.
 *
 * {@see testEveryAuthInvariantHasATest()} makes that mapping mechanical, so a new
 * invariant cannot be added to the contract without a test arriving with it.
 *
 * Everything here drives the real front controller through {@see Kernel::handle()}
 * rather than calling `Authenticator` directly. The properties being asserted are
 * properties of the HTTP surface, and a test that reached past it could pass while
 * the surface was wired wrong.
 */
final class AuthenticationTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    /** Invariant id => the method proving it. */
    private const INVARIANT_TESTS = [
        'auth.sessionIdRotatesOnLogin' => 'testTheSessionIdRotatesOnLogin',
        'auth.csrfTokenRotatesWithTheSession' => 'testTheCsrfTokenRotatesWithTheSession',
        'auth.logoutInvalidatesServerSide' => 'testLogoutInvalidatesTheSessionServerSide',
        'auth.failureModesAreIndistinguishable' => 'testTheThreeLoginFailuresAreIndistinguishable',
        'auth.disabledAccountIsRejectedOnEveryRequest' => 'testDisablingAnAccountEndsItsLiveSession',
        'auth.sessionCookieCarriesItsAttributes' => 'testTheSessionCookieCarriesItsAttributes',
        'auth.responsesNeverEchoSecrets' => 'testNoResponseOrLogLineCarriesASecret',
        'csrf.readsAreExempt' => 'testReadsNeedNoCsrfToken',
    ];

    private string $root;
    private InMemoryAccountDirectory $accounts;
    private InMemorySessionStore $sessions;
    private Kernel $kernel;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-auth');
        $clock = new FrozenClock(self::NOW);

        $this->accounts = InMemoryAccountDirectory::withAccount(true);
        $this->sessions = new InMemorySessionStore($clock);

        $configPath = TestEnvironment::writeDeployment($this->root);
        TestEnvironment::writeExportedPage($this->root);

        $this->kernel = Kernel::boot(
            $configPath,
            $clock,
            null,
            null,
            $this->accounts,
            $this->sessions,
        );
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testEveryAuthInvariantHasATest(): void
    {
        /** @var list<array{id: string, description: string}> $invariants */
        $invariants = TestEnvironment::artifacts()->httpContract()['invariants'];

        $declared = [];
        foreach ($invariants as $invariant) {
            if (str_starts_with($invariant['id'], 'auth.') || str_starts_with($invariant['id'], 'csrf.')) {
                $declared[] = $invariant['id'];
            }
        }

        sort($declared);
        $covered = array_keys(self::INVARIANT_TESTS);
        sort($covered);

        // Equality in both directions: an invariant the contract declares must
        // have a test here, and a mapping here must name an invariant that still
        // exists. Without the second half, a deleted invariant leaves behind a
        // test nobody realises is now testing nothing in particular.
        self::assertSame($declared, $covered);

        foreach (self::INVARIANT_TESTS as $invariant => $method) {
            self::assertTrue(method_exists($this, $method), "{$invariant} names a missing method");
        }
    }

    public function testTheSessionIdRotatesOnLogin(): void
    {
        $anonymous = $this->openAnonymousSession();
        $before = $anonymous['sessionId'];

        $response = $this->login($before, $anonymous['csrfToken']);
        $after = self::cookieValue($response);

        self::assertSame(200, $response->status);
        self::assertNotSame($before, $after);

        // The pre-login row is gone, not merely unreferenced. An attacker who
        // fixed the id in the victim's browser holds an id that names nothing.
        self::assertArrayNotHasKey($before, $this->sessions->sessions);

        self::assertFalse($this->sessionState($before)['authenticated']);
    }

    public function testTheCsrfTokenRotatesWithTheSession(): void
    {
        $anonymous = $this->openAnonymousSession();
        $staleToken = $anonymous['csrfToken'];

        $response = $this->login($anonymous['sessionId'], $staleToken);
        $sessionId = self::cookieValue($response);

        /** @var array<string, mixed> $body */
        $body = $response->decodedBody();
        self::assertNotSame($staleToken, $body['csrfToken']);

        // The captured token is refused against the authenticated session, and
        // the one the login handed back is accepted. Both halves matter: only
        // asserting the rejection would also pass if *every* token were refused.
        self::assertSame(403, $this->logout($sessionId, $staleToken)->status);
        self::assertSame(204, $this->logout($sessionId, (string) $body['csrfToken'])->status);
    }

    public function testLogoutInvalidatesTheSessionServerSide(): void
    {
        $signedIn = $this->signIn();

        self::assertSame(204, $this->logout($signedIn['sessionId'], $signedIn['csrfToken'])->status);
        self::assertArrayNotHasKey($signedIn['sessionId'], $this->sessions->sessions);

        // Replaying the exact pre-logout cookie: a client that ignored Set-Cookie
        // gains nothing, because invalidation was the deletion of the row.
        $replayed = $this->kernel->handle(new Request(
            'GET',
            '/api/auth/session',
            ['cookie' => $this->cookieName() . '=' . $signedIn['sessionId']],
        ));

        /** @var array<string, mixed> $body */
        $body = $replayed->decodedBody();

        self::assertSame(200, $replayed->status);
        self::assertFalse($body['authenticated']);
        self::assertNull($body['account']);

        // And the replay does not resurrect the id: a fresh anonymous session is
        // minted under a new one.
        self::assertNotSame($signedIn['sessionId'], self::cookieValue($replayed));
    }

    /**
     * @return iterable<string, array{string, string, string}>
     */
    public static function loginFailures(): iterable
    {
        yield 'unknown address' => ['nobody@example.test', InMemoryAccountDirectory::PASSWORD, 'missing'];
        yield 'wrong password' => [InMemoryAccountDirectory::EMAIL, 'not-the-password', 'enabled'];
        yield 'disabled account' => [InMemoryAccountDirectory::EMAIL, InMemoryAccountDirectory::PASSWORD, 'disabled'];
        yield 'malformed address' => ['not-an-address', InMemoryAccountDirectory::PASSWORD, 'enabled'];
    }

    #[DataProvider('loginFailures')]
    public function testTheThreeLoginFailuresAreIndistinguishable(
        string $email,
        string $password,
        string $accountState,
    ): void {
        if ($accountState === 'missing') {
            $this->accounts->remove(1);
        }

        if ($accountState === 'disabled') {
            $this->accounts->setEnabled(1, false);
        }

        $anonymous = $this->openAnonymousSession();
        $response = $this->login($anonymous['sessionId'], $anonymous['csrfToken'], $email, $password);

        /** @var array<string, mixed> $body */
        $body = $response->decodedBody();

        self::assertSame(401, $response->status);
        self::assertSame('INVALID_CREDENTIALS', $body['error']['code']);

        // Every header except the correlation id must match too — a `Set-Cookie`,
        // a `WWW-Authenticate` or an `Allow` present on one failure and not another
        // would separate them just as effectively as a different code would.
        $headers = array_change_key_case($response->headers);
        unset($headers['x-request-id']);
        self::assertSame(['content-type' => Response::JSON_CONTENT_TYPE], $headers);

        // A malformed address is a *failed lookup*, not a validation error: 400
        // here would tell an attacker which of its guesses were even addresses.
        self::assertNotSame(400, $response->status);
    }

    public function testARecordLoginFailureAfterRotationPublishesNoSessionAndRestoresTheAnonymousOne(): void
    {
        // ESZ-134. The defect: rotate() deletes the anonymous row, persists the
        // authenticated session and arms its cookie *before* recordLogin runs,
        // so a failure there used to answer 500 while handing out the new
        // authenticated cookie and leaving the authenticated row behind.
        $anonymous = $this->openAnonymousSession();
        $anonymousCount = \count($this->sessions->sessions);

        $this->accounts->throwOnRecordLogin = true;
        $response = $this->login($anonymous['sessionId'], $anonymous['csrfToken']);
        /** @var array<string, mixed> $body */
        $body = $response->decodedBody();

        // An error response, never a false success — and no session cookie on it.
        self::assertSame(500, $response->status);
        self::assertSame('INTERNAL_ERROR', $body['error']['code']);
        self::assertNull($response->header('Set-Cookie'), 'the failure response published a session cookie');

        // The login itself was never recorded as successful.
        self::assertSame([], $this->accounts->recordedLogins);

        // The rotation did persist an authenticated session for one moment; it
        // must be gone now, and no authenticated row may remain anywhere.
        $rotatedId = null;
        foreach ($this->sessions->saveHistory as $entry) {
            if ($entry['accountId'] !== null) {
                $rotatedId = $entry['id'];
            }
        }

        self::assertNotNull($rotatedId, 'the rotation never saved an authenticated session');
        self::assertNull($this->sessions->find($rotatedId), 'the rotated session row survived the failure');

        foreach ($this->sessions->sessions as $id => $session) {
            self::assertNull($session->accountId, "session {$id} is still authenticated");
        }

        // The pre-login anonymous state was restored consistently: the same row
        // count, the same id, the same CSRF token — so the client's existing
        // cookie keeps working without a reissue.
        self::assertCount($anonymousCount, $this->sessions->sessions);
        self::assertArrayHasKey($anonymous['sessionId'], $this->sessions->sessions);

        $replayed = $this->sessionResponse($anonymous['sessionId']);
        /** @var array<string, mixed> $replayedBody */
        $replayedBody = $replayed->decodedBody();
        self::assertSame(200, $replayed->status);
        self::assertFalse($replayedBody['authenticated']);
        self::assertSame($anonymous['csrfToken'], $replayedBody['csrfToken']);
        self::assertNull($replayed->header('Set-Cookie'), 'a restored session must not be reissued');

        // The id the failed rotation minted cannot authorise anything later.
        $stolen = $this->sessionResponse($rotatedId);
        /** @var array<string, mixed> $stolenBody */
        $stolenBody = $stolen->decodedBody();
        self::assertFalse($stolenBody['authenticated']);

        // And the same anonymous cookie and token sign in cleanly on the next
        // attempt: the failure consumed nothing.
        $this->accounts->throwOnRecordLogin = false;
        $retry = $this->login($anonymous['sessionId'], $anonymous['csrfToken']);
        self::assertSame(200, $retry->status, 'the restored anonymous session must accept a retry');
    }

    public function testARotationRevocationFailureStillNeverPublishesAuthentication(): void
    {
        // ESZ-134, third injected failure: the compensation itself (destroying
        // the rotated row) can fail. It must still never publish authentication:
        // the request-local state is reconciled before the store is touched, so
        // the error response carries no cookie no matter what the store does.
        $anonymous = $this->openAnonymousSession();

        // The rotation's own destroy of the anonymous row succeeds and arms the
        // store; the revocation's destroy of the rotated row then throws.
        $this->sessions->armThrowOnNextDestroy = true;
        $this->accounts->throwOnRecordLogin = true;

        $response = $this->login($anonymous['sessionId'], $anonymous['csrfToken']);
        /** @var array<string, mixed> $body */
        $body = $response->decodedBody();

        self::assertSame(500, $response->status);
        self::assertSame('INTERNAL_ERROR', $body['error']['code']);
        self::assertNull($response->header('Set-Cookie'), 'the failure response published a session cookie');

        $rotatedId = null;
        foreach ($this->sessions->saveHistory as $entry) {
            if ($entry['accountId'] !== null) {
                $rotatedId = $entry['id'];
            }
        }

        self::assertNotNull($rotatedId);

        // The compensation failure is an operational event, not a secret: no
        // session id may reach the log either.
        $log = (string) @file_get_contents($this->root . '/var/log/app.log');
        self::assertStringNotContainsString($rotatedId, $log);
        self::assertStringNotContainsString(InMemoryAccountDirectory::PASSWORD, $log);

        // The pre-rotation session was restored before the compensation could
        // fail, so the anonymous cookie keeps working.
        $replayed = $this->sessionResponse($anonymous['sessionId']);
        /** @var array<string, mixed> $replayedBody */
        $replayedBody = $replayed->decodedBody();
        self::assertSame(200, $replayed->status);
        self::assertFalse($replayedBody['authenticated']);
    }

    public function testDisablingAnAccountEndsItsLiveSession(): void
    {
        $signedIn = $this->signIn();

        // Still signed in, to be sure the next assertion is about the disabling
        // rather than about the session never having worked.
        self::assertTrue($this->sessionState($signedIn['sessionId'])['authenticated']);

        $this->accounts->setEnabled(1, false);

        // Enforcement is on the next request, not at the next login. The session
        // row survives — destroying it would erase the evidence that it existed —
        // but it stops authenticating anything.
        $state = $this->sessionState($signedIn['sessionId']);

        self::assertFalse($state['authenticated']);
        self::assertNull($state['account']);
        self::assertArrayHasKey($signedIn['sessionId'], $this->sessions->sessions);
        self::assertNull($this->sessions->sessions[$signedIn['sessionId']]->accountId);

        // And a privileged call from that session is refused outright.
        self::assertSame(
            401,
            $this->logout($signedIn['sessionId'], $signedIn['csrfToken'])->status,
        );
    }

    public function testTheSessionCookieCarriesItsAttributes(): void
    {
        /** @var array<string, mixed> $contract */
        $contract = TestEnvironment::artifacts()->authContract()['sessionCookie'];

        $response = $this->kernel->handle(new Request('GET', '/api/auth/session'));
        $cookie = $response->header('Set-Cookie');

        self::assertIsString($cookie);
        self::assertStringStartsWith($contract['name'] . '=', $cookie);
        self::assertStringContainsString('HttpOnly', $cookie);
        self::assertStringContainsString('SameSite=' . $contract['sameSite'], $cookie);
        self::assertStringContainsString('Path=' . $contract['path'], $cookie);
        self::assertStringContainsString('Secure', $cookie);

        // A Domain would widen the cookie to every subdomain and void the
        // `__Host-` guarantee the name is claiming.
        self::assertStringNotContainsStringIgnoringCase('Domain=', $cookie);

        // The id in the cookie is the opaque random one, not anything derived
        // from the account.
        $value = self::cookieValue($response);
        self::assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $value);
    }

    public function testNoResponseOrLogLineCarriesASecret(): void
    {
        $signedIn = $this->signIn();
        $account = $this->accounts->findById(1);
        self::assertNotNull($account);

        $responses = [
            $this->sessionResponse($signedIn['sessionId']),
            $this->login($signedIn['sessionId'], $signedIn['csrfToken'], InMemoryAccountDirectory::EMAIL, 'wrong'),
        ];

        foreach ($responses as $response) {
            foreach (
                [
                    InMemoryAccountDirectory::PASSWORD,
                    $account->passwordHash,
                    $signedIn['sessionId'],
                    'passwordHash',
                    'password_hash',
                ] as $secret
            ) {
                self::assertStringNotContainsString($secret, $response->body);
            }
        }

        // The log is not a public place, but a password written to it is a
        // password that outlives the incident. The rejected login above logged a
        // line naming the address, which is deliberate and must not have brought
        // the password with it.
        $log = (string) @file_get_contents($this->root . '/var/log/app.log');

        self::assertStringNotContainsString(InMemoryAccountDirectory::PASSWORD, $log);
        self::assertStringNotContainsString($account->passwordHash, $log);
        self::assertStringNotContainsString($signedIn['sessionId'], $log);
        self::assertStringNotContainsString($signedIn['csrfToken'], $log);
    }

    public function testReadsNeedNoCsrfToken(): void
    {
        // A caller with no token at all must be able to obtain one, or it could
        // never make a first state-changing call.
        foreach (['/api/auth/session', '/api/health', '/api/content', '/'] as $path) {
            $response = $this->kernel->handle(new Request('GET', $path));

            self::assertNotSame(403, $response->status, $path);
        }

        $body = $this->kernel->handle(new Request('GET', '/api/auth/session'))->decodedBody();

        self::assertIsArray($body);
        self::assertNotSame('', $body['csrfToken']);
    }

    // --- helpers -----------------------------------------------------------

    private function cookieName(): string
    {
        /** @var array<string, mixed> $cookie */
        $cookie = TestEnvironment::artifacts()->authContract()['sessionCookie'];
        /** @var string $name */
        $name = $cookie['name'];

        return $name;
    }

    private function csrfHeader(): string
    {
        /** @var array<string, mixed> $csrf */
        $csrf = TestEnvironment::artifacts()->authContract()['csrf'];
        /** @var string $header */
        $header = $csrf['header'];

        return $header;
    }

    private static function cookieValue(Response $response): string
    {
        $cookie = (string) $response->header('Set-Cookie');
        $equals = strpos($cookie, '=');
        $semicolon = strpos($cookie, ';');

        if ($equals === false || $semicolon === false) {
            return '';
        }

        return substr($cookie, $equals + 1, $semicolon - $equals - 1);
    }

    /** @return array{sessionId: string, csrfToken: string} */
    private function openAnonymousSession(): array
    {
        $response = $this->kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $body */
        $body = $response->decodedBody();

        return [
            'sessionId' => self::cookieValue($response),
            'csrfToken' => (string) $body['csrfToken'],
        ];
    }

    /** @return array{sessionId: string, csrfToken: string} */
    private function signIn(): array
    {
        $anonymous = $this->openAnonymousSession();
        $response = $this->login($anonymous['sessionId'], $anonymous['csrfToken']);

        self::assertSame(200, $response->status, 'the fixture sign-in failed');

        /** @var array<string, mixed> $body */
        $body = $response->decodedBody();

        return [
            'sessionId' => self::cookieValue($response),
            'csrfToken' => (string) $body['csrfToken'],
        ];
    }

    private function login(
        string $sessionId,
        string $csrfToken,
        string $email = InMemoryAccountDirectory::EMAIL,
        string $password = InMemoryAccountDirectory::PASSWORD,
    ): Response {
        return $this->kernel->handle(new Request(
            'POST',
            '/api/auth/login',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                $this->csrfHeader() => $csrfToken,
                'content-type' => 'application/json',
            ],
            (string) json_encode(['email' => $email, 'password' => $password]),
        ));
    }

    private function logout(string $sessionId, string $csrfToken): Response
    {
        return $this->kernel->handle(new Request(
            'POST',
            '/api/auth/logout',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                $this->csrfHeader() => $csrfToken,
            ],
        ));
    }

    private function sessionResponse(string $sessionId): Response
    {
        return $this->kernel->handle(new Request(
            'GET',
            '/api/auth/session',
            ['cookie' => $this->cookieName() . '=' . $sessionId],
        ));
    }

    /** @return array<string, mixed> */
    private function sessionState(string $sessionId): array
    {
        /** @var array<string, mixed> $body */
        $body = $this->sessionResponse($sessionId)->decodedBody();

        return $body;
    }
}
