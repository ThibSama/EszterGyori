<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Admin\AdminAccountRepository;
use Eszter\Admin\AdminEmail;
use Eszter\Auth\PdoSessionStore;
use Eszter\Auth\Session;
use Eszter\Config\SessionSettings;
use Eszter\Database\Database;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Support\FrozenClock;
use Eszter\Support\IsoTimestamp;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/**
 * The `sql:integration` gate (ESZ-023 / ESZ-024 / ESZ-025).
 *
 * "Admin, booking, settings and notification repositories against a real MySQL
 * instance seeded from migrations, each test isolated in a rolled-back
 * transaction." — `docs/v1-quality-gates.md`. Booking, settings and notifications
 * do not exist yet; admin accounts and sessions do, and they are what this covers.
 *
 * The schema is built by running the real migrations once, so this gate also
 * proves that what `sql:migrations` produces is what the repositories were
 * written against — a schema hand-built for the tests would let the two drift.
 *
 * ## Isolation
 *
 * Each test runs inside a transaction that is rolled back in `tearDown()`. Every
 * repository shares one connection, so they all see the same uncommitted state
 * and none of it survives the test. `TRUNCATE` is not used per test because it
 * commits implicitly on MySQL and would defeat the rollback.
 *
 * The last group of tests drives the real front controller against this database,
 * which is the only place in the suite where authentication, CSRF and MySQL are
 * exercised together. `php:http-contract` proves the same surface against
 * in-memory doubles; this proves the doubles were not lying.
 */
#[Group('sql')]
final class SqlIntegrationTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const EMAIL = 'editor@example.test';
    private const PASSWORD = 'correct-horse-battery';

    private static bool $migrated = false;

    private Database $database;
    private FrozenClock $clock;
    private AdminAccountRepository $accounts;
    private PdoSessionStore $sessions;
    private string $root;

    protected function setUp(): void
    {
        if (!TestDatabase::isConfigured()) {
            self::markTestSkipped(TestDatabase::skipReason());
        }

        $this->database = TestDatabase::connect();

        if (!self::$migrated) {
            TestDatabase::dropEverything($this->database);
            TestDatabase::migrator($this->database)->migrate();
            self::$migrated = true;
        }

        TestDatabase::truncateData($this->database);

        $this->clock = new FrozenClock(self::NOW);
        $this->accounts = new AdminAccountRepository($this->database, $this->clock);
        $this->sessions = new PdoSessionStore($this->database, $this->clock);
        $this->root = TestEnvironment::makeTempDirectory('eszter-sql');

        $this->database->beginTransaction();
    }

    protected function tearDown(): void
    {
        if (isset($this->database) && $this->database->inTransaction()) {
            $this->database->rollBack();
        }

        if (isset($this->root)) {
            TestEnvironment::removeDirectory($this->root);
        }
    }

    // --- ESZ-024: admin identity -------------------------------------------

    public function testProvisioningCreatesAnAccountAndIsSafeToRepeat(): void
    {
        $email = $this->email(self::EMAIL);

        $first = $this->accounts->provision($email, self::PASSWORD, true);

        self::assertTrue($first['created']);
        self::assertSame(self::EMAIL, $first['account']->email);
        self::assertTrue($first['account']->isEnabled);

        // The realistic second run: the operator is not sure the first one worked.
        // It must update the same row, not fail on the unique index and not create
        // a second account.
        $second = $this->accounts->provision($email, self::PASSWORD, true);

        self::assertFalse($second['created']);
        self::assertSame($first['account']->id, $second['account']->id);
        self::assertCount(1, $this->accounts->all());
    }

    public function testTheStoredPasswordIsAHashAndVerifiesAgainstThePlaintext(): void
    {
        $account = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];

        // The column holds a hash, and specifically not the password.
        self::assertNotSame(self::PASSWORD, $account->passwordHash);
        self::assertStringNotContainsString(self::PASSWORD, $account->passwordHash);
        self::assertTrue(password_verify(self::PASSWORD, $account->passwordHash));
        self::assertFalse(password_verify('wrong', $account->passwordHash));

        // A modern algorithm, not a legacy one that merely happens to work.
        $info = password_get_info($account->passwordHash);
        self::assertContains($info['algoName'], ['argon2id', 'argon2i', 'bcrypt']);
        self::assertFalse(AdminAccountRepository::needsRehash($account->passwordHash));

        // And nothing about the account serialises the hash by accident.
        self::assertStringNotContainsString(
            $account->passwordHash,
            (string) json_encode($account) . print_r($account, true),
        );
    }

    public function testTwoSpellingsOfOneAddressAreOneAccount(): void
    {
        $this->accounts->provision($this->email('Editor@Example.TEST'), self::PASSWORD, true);
        $result = $this->accounts->provision($this->email('  editor@example.test  '), 'another-password', true);

        // Normalisation is what makes the unique index mean "one person". Without
        // it these are two rows and one of them is unreachable while looking,
        // from outside, exactly like a wrong password.
        self::assertFalse($result['created']);
        self::assertCount(1, $this->accounts->all());
        self::assertSame('editor@example.test', $result['account']->email);
    }

    public function testAnAccentDifferenceIsTwoDifferentAccounts(): void
    {
        // The reason `email` is utf8mb4_bin rather than the table's accent- and
        // case-insensitive default: under `utf8mb4_unicode_ci` these two collide
        // on the unique index and the second insert fails.
        $this->accounts->provision($this->email('rene@example.test'), self::PASSWORD, true);
        $this->accounts->provision($this->email('renée@example.test'), self::PASSWORD, true);

        self::assertCount(2, $this->accounts->all());
    }

    public function testProvisioningCanDisableWithoutKnowingThePassword(): void
    {
        $created = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];

        $result = $this->accounts->provision($this->email(self::EMAIL), null, false);

        self::assertFalse($result['account']->isEnabled);
        self::assertFalse($result['passwordChanged']);
        // The hash is untouched, so re-enabling restores the same credential.
        self::assertSame($created->passwordHash, $result['account']->passwordHash);
    }

    public function testANewAccountWithoutAPasswordIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        $this->accounts->provision($this->email(self::EMAIL), null, true);
    }

    public function testAMalformedAddressIsRefusedAtProvisioningTime(): void
    {
        // Provisioning validates, because the operator is the one being helped.
        // Login deliberately does not — see `auth.loginFailure`.
        $this->expectException(\InvalidArgumentException::class);

        $this->email('not-an-address');
    }

    public function testRecordingALoginUpdatesOnlyTheTimestamp(): void
    {
        $account = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];
        self::assertNull($account->lastLoginAt);

        $this->accounts->recordLogin($account->id, '2026-07-01T09:00:00.000Z');

        $reloaded = $this->accounts->findById($account->id);
        self::assertNotNull($reloaded);
        self::assertSame('2026-07-01T09:00:00.000Z', $reloaded->lastLoginAt);
        self::assertSame($account->passwordHash, $reloaded->passwordHash);
        self::assertSame($account->isEnabled, $reloaded->isEnabled);
    }

    // --- ESZ-025: sessions --------------------------------------------------

    public function testASessionRoundTripsThroughMysql(): void
    {
        $session = $this->session(null, '+1 hour', '+12 hours');
        $this->sessions->save($session);

        $found = $this->sessions->find($session->id);

        self::assertNotNull($found);
        self::assertSame($session->id, $found->id);
        self::assertSame($session->csrfToken, $found->csrfToken);
        self::assertNull($found->accountId);
        self::assertFalse($found->isAuthenticated());
    }

    public function testAnIdleExpiredSessionIsNotFound(): void
    {
        $this->sessions->save($expired = $this->session(null, '-1 second', '+12 hours'));

        // Expiry is decided in the query, not by a caller who might forget.
        self::assertNull($this->sessions->find($expired->id));
    }

    public function testASessionPastItsAbsoluteCeilingIsNotFound(): void
    {
        // Idle deadline in the future, absolute deadline in the past: the shape a
        // continuously-used — that is, stolen — session ends up in.
        $this->sessions->save($session = $this->session(null, '+1 hour', '-1 second'));

        self::assertNull($this->sessions->find($session->id));
    }

    public function testUsingASessionExtendsIdleButNeverTheAbsoluteCeiling(): void
    {
        $this->sessions->save($session = $this->session(null, '+10 minutes', '+30 minutes'));

        // What SessionManager::touch() writes: a new idle deadline, and an
        // absolute one it tries — and must fail — to push out.
        $this->sessions->save(new Session(
            $session->id,
            $session->accountId,
            $session->csrfToken,
            $session->createdAt,
            self::NOW,
            $this->at('+1 hour'),
            $this->at('+99 hours'),
        ));

        $found = $this->sessions->find($session->id);

        self::assertNotNull($found);
        self::assertSame($this->at('+1 hour'), $found->expiresAt);
        self::assertSame(
            $this->at('+30 minutes'),
            $found->absoluteExpiresAt,
            'the absolute ceiling was extended by using the session',
        );
    }

    public function testDestroyingASessionRemovesTheRow(): void
    {
        $this->sessions->save($session = $this->session(null, '+1 hour', '+12 hours'));

        $this->sessions->destroy($session->id);

        self::assertNull($this->sessions->find($session->id));
        self::assertSame([], $this->database->fetchAll('SELECT id FROM admin_sessions'));
    }

    public function testDisablingAnAccountCanSignItOutEverywhere(): void
    {
        $account = $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true)['account'];
        $other = $this->accounts->provision($this->email('other@example.test'), self::PASSWORD, true)['account'];

        $this->sessions->save($this->session($account->id, '+1 hour', '+12 hours'));
        $this->sessions->save($this->session($account->id, '+1 hour', '+12 hours'));
        $this->sessions->save($mine = $this->session($other->id, '+1 hour', '+12 hours'));

        self::assertSame(2, $this->sessions->destroyForAccount($account->id));

        // Someone else's sessions are untouched.
        self::assertNotNull($this->sessions->find($mine->id));
    }

    public function testGarbageCollectionRemovesOnlyExpiredSessions(): void
    {
        $this->sessions->save($live = $this->session(null, '+1 hour', '+12 hours'));
        $this->sessions->save($this->session(null, '-1 second', '+12 hours'));
        $this->sessions->save($this->session(null, '+1 hour', '-1 second'));

        self::assertSame(2, $this->sessions->collectGarbage());
        self::assertNotNull($this->sessions->find($live->id));
    }

    public function testAMalformedSessionIdNeverReachesTheDatabase(): void
    {
        // Not a correctness fix — a malformed id cannot match a row anyway — but a
        // hygiene one: attacker-chosen bytes never enter a query or a query log.
        foreach (["' OR 1=1 --", str_repeat('z', 64), '', 'ABCDEF'] as $id) {
            self::assertNull($this->sessions->find($id));
        }
    }

    // --- ESZ-025 / ESZ-026 end to end, against MySQL ------------------------

    public function testTheWholeAuthFlowWorksAgainstMysql(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();

        // 1. An anonymous caller obtains a CSRF token.
        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();

        self::assertSame(200, $anonymous->status);
        self::assertFalse($anonymousBody['authenticated']);

        $sessionId = self::cookieValue($anonymous);
        $token = (string) $anonymousBody['csrfToken'];

        // 2. Wrong password: 401, and the row in MySQL is still anonymous.
        $rejected = $this->login($kernel, $sessionId, $token, 'wrong-password');
        self::assertSame(401, $rejected->status);
        self::assertNull($this->sessions->find($sessionId)?->accountId);

        // 3. Correct password with a valid token: 200, and the id rotates.
        $accepted = $this->login($kernel, $sessionId, $token, self::PASSWORD);
        /** @var array<string, mixed> $body */
        $body = $accepted->decodedBody();
        $newSessionId = self::cookieValue($accepted);

        self::assertSame(200, $accepted->status);
        self::assertTrue($body['authenticated']);
        self::assertNotSame($sessionId, $newSessionId);
        self::assertNull($this->sessions->find($sessionId), 'the pre-login row survived in MySQL');

        // The account really is attached, in the database, not just in the body.
        $stored = $this->sessions->find($newSessionId);
        self::assertNotNull($stored);
        self::assertNotNull($stored->accountId);

        // 4. Logout with the stale token is refused; with the fresh one it works.
        $newToken = (string) $body['csrfToken'];
        self::assertSame(403, $this->logout($kernel, $newSessionId, $token)->status);
        self::assertNotNull($this->sessions->find($newSessionId));

        self::assertSame(204, $this->logout($kernel, $newSessionId, $newToken)->status);
        self::assertNull($this->sessions->find($newSessionId), 'logout left the row in MySQL');
    }

    public function testADisabledAccountCannotSignInAgainstMysql(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, false);
        $kernel = $this->bootAgainstMysql();

        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();

        $response = $this->login(
            $kernel,
            self::cookieValue($anonymous),
            (string) $anonymousBody['csrfToken'],
            self::PASSWORD,
        );

        /** @var array<string, mixed> $body */
        $body = $response->decodedBody();

        // The password is correct. Disabling is what refuses it, and it refuses it
        // with the same envelope a wrong password gets.
        self::assertSame(401, $response->status);
        self::assertSame('INVALID_CREDENTIALS', $body['error']['code']);
        self::assertNull($response->header('Set-Cookie'));
    }

    public function testNoDatabaseCredentialAppearsInAnyResponseOrLog(): void
    {
        $this->accounts->provision($this->email(self::EMAIL), self::PASSWORD, true);
        $kernel = $this->bootAgainstMysql();

        $anonymous = $kernel->handle(new Request('GET', '/api/auth/session'));
        /** @var array<string, mixed> $anonymousBody */
        $anonymousBody = $anonymous->decodedBody();
        $this->login($kernel, self::cookieValue($anonymous), (string) $anonymousBody['csrfToken'], 'wrong');

        $settings = TestDatabase::settings();
        $log = (string) @file_get_contents($this->root . '/var/log/app.log');

        foreach ([$anonymous->body, $log] as $text) {
            if ($settings->password !== '') {
                self::assertStringNotContainsString($settings->password, $text);
            }
            self::assertStringNotContainsString($settings->dsn, $text);
            self::assertStringNotContainsString(self::PASSWORD, $text);
        }
    }

    // --- helpers -----------------------------------------------------------

    private function email(string $raw): AdminEmail
    {
        return AdminEmail::fromString($raw, TestEnvironment::artifacts());
    }

    private function at(string $offset): string
    {
        return IsoTimestamp::format($this->clock->now()->modify($offset));
    }

    private function session(?int $accountId, string $idle, string $absolute): Session
    {
        return new Session(
            Session::newId(),
            $accountId,
            Session::newCsrfToken(),
            self::NOW,
            self::NOW,
            $this->at($idle),
            $this->at($absolute),
        );
    }

    /**
     * The real front controller, wired to this MySQL connection.
     *
     * Passing the same `Database` the test uses is what keeps the kernel inside
     * the test's transaction — a second connection would not see the uncommitted
     * account, and rolling back would not undo what the kernel wrote.
     */
    private function bootAgainstMysql(): Kernel
    {
        $configPath = TestEnvironment::writeDeployment($this->root);
        TestEnvironment::writeExportedPage($this->root);

        return Kernel::boot(
            $configPath,
            $this->clock,
            null,
            null,
            new AdminAccountRepository($this->database, $this->clock),
            new PdoSessionStore($this->database, $this->clock),
        );
    }

    private static function cookieValue(Response $response): string
    {
        $cookie = (string) $response->header('Set-Cookie');

        return preg_match('/=([0-9a-f]{64});/', $cookie, $match) === 1 ? $match[1] : '';
    }

    private function login(Kernel $kernel, string $sessionId, string $token, string $password): Response
    {
        return $kernel->handle(new Request(
            'POST',
            '/api/auth/login',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                $this->csrfHeader() => $token,
                'content-type' => 'application/json',
            ],
            (string) json_encode(['email' => self::EMAIL, 'password' => $password]),
        ));
    }

    private function logout(Kernel $kernel, string $sessionId, string $token): Response
    {
        return $kernel->handle(new Request(
            'POST',
            '/api/auth/logout',
            [
                'cookie' => $this->cookieName() . '=' . $sessionId,
                $this->csrfHeader() => $token,
            ],
        ));
    }

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
}
