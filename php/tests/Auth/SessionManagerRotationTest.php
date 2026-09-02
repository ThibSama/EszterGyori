<?php

declare(strict_types=1);

namespace Eszter\Tests\Auth;

use Eszter\Auth\Session;
use Eszter\Auth\SessionCookie;
use Eszter\Auth\SessionManager;
use Eszter\Config\SessionSettings;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The rotation lifecycle `SessionManager` owns (ESZ-134).
 *
 * {@see SessionManager::rotate()} is provisional by design: it deletes the
 * pre-login row, persists the authenticated session and arms its cookie before
 * the rest of a login has run. These tests pin down the revocation half of that
 * lifecycle — what {@see SessionManager::revokeRotation()} must restore, in
 * which order, and what it must never do — independently of the HTTP surface
 * {@see \Eszter\Tests\Auth\AuthenticationTest} proves it through.
 */
final class SessionManagerRotationTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private InMemorySessionStore $store;
    private SessionManager $manager;

    protected function setUp(): void
    {
        $clock = new FrozenClock(self::NOW);
        $this->store = new InMemorySessionStore($clock);
        $this->manager = new SessionManager(
            $this->store,
            SessionCookie::fromArtifacts(TestEnvironment::artifacts(), true),
            new SessionSettings(),
            $clock,
        );
    }

    public function testRevokingAFailedRotationRestoresThePreRotationSessionAndPublishesNothing(): void
    {
        $anonymous = $this->loadAnonymous();
        $rotated = $this->manager->rotate(7);

        // Sanity: the rotation really is in effect before the revocation.
        $rotatedCurrent = $this->manager->current();
        self::assertNotNull($rotatedCurrent, 'rotation did not take effect');
        self::assertSame($rotated->id, $rotatedCurrent->id);
        self::assertSame(7, $rotatedCurrent->accountId);
        self::assertNull($this->store->find($anonymous->id), 'the pre-login row survived the rotation');

        $this->manager->revokeRotation();

        // The pre-login session is current again, exactly as it was: same id,
        // same token, anonymous.
        $current = $this->manager->current();
        self::assertNotNull($current);
        self::assertSame($anonymous->id, $current->id);
        self::assertSame($anonymous->csrfToken, $current->csrfToken);
        self::assertNull($current->accountId);

        $restored = $this->store->find($anonymous->id);
        self::assertNotNull($restored, 'the pre-login row was not restored in the store');
        self::assertNull($restored->accountId);

        self::assertNull($this->store->find($rotated->id), 'the rotated row survived the revocation');

        // The client already holds the restored cookie, so the response must
        // not carry a Set-Cookie of any kind.
        $response = $this->manager->applyTo(Response::json(200, ['ok' => true]));
        self::assertNull($response->header('Set-Cookie'));
    }

    public function testRevokingWithoutARotationChangesNothing(): void
    {
        $anonymous = $this->loadAnonymous();

        $this->manager->revokeRotation();

        self::assertSame($anonymous->id, $this->manager->current()?->id);
        self::assertNotNull($this->store->find($anonymous->id));
    }

    public function testARotationWhoseSessionPersistFailedIsStillRevocable(): void
    {
        $anonymous = $this->loadAnonymous();

        // rotate() destroyed the pre-login row and then failed to persist the
        // rotated one — the shape a dead database leaves behind.
        $this->store->throwOnSave = true;

        try {
            $this->manager->rotate(7);
            self::fail('rotate() should have failed to persist the rotated session');
        } catch (\RuntimeException $exception) {
            self::assertSame('Forced session save failure.', $exception->getMessage());
        }

        self::assertNull($this->store->find($anonymous->id), 'rotate() destroyed the pre-login row before failing');

        $this->store->throwOnSave = false;
        $this->manager->revokeRotation();

        $current = $this->manager->current();
        self::assertNotNull($current);
        self::assertNull($current->accountId);
        self::assertSame($anonymous->id, $current->id);

        $restored = $this->store->find($anonymous->id);
        self::assertNotNull($restored, 'revocation did not restore the row the failed rotation destroyed');
        self::assertNull($restored->accountId);
    }

    public function testARevocationWhoseStoreCompensationFailsReconcilesLocalStateFirst(): void
    {
        $anonymous = $this->loadAnonymous();

        // The rotation's own destroy of the anonymous row is allowed through and
        // arms the store; the revocation's destroy of the rotated row throws.
        $this->store->armThrowOnNextDestroy = true;
        $rotated = $this->manager->rotate(7);

        try {
            $this->manager->revokeRotation();
            self::fail('revokeRotation() should have failed on the store compensation');
        } catch (\RuntimeException $exception) {
            self::assertSame('Forced session destroy failure.', $exception->getMessage());
        }

        // The request-local state was reconciled *before* the compensation ran,
        // so even though the store threw, this request holds no authenticated
        // session and would publish no cookie.
        $current = $this->manager->current();
        self::assertNotNull($current);
        self::assertSame($anonymous->id, $current->id);
        self::assertNull($current->accountId);

        $response = $this->manager->applyTo(Response::json(200, ['ok' => true]));
        self::assertNull($response->header('Set-Cookie'), 'a failed revocation still published a cookie');

        // The pre-rotation row was restored before the compensation failed; the
        // rotated row survives only because its destroy failed, and its id was
        // never handed to anyone.
        self::assertNotNull($this->store->find($anonymous->id));
        self::assertNotNull($this->store->find($rotated->id));
    }

    /** Seeds an anonymous session and loads it, the way a real request would. */
    private function loadAnonymous(): Session
    {
        $seeded = $this->store->seed(null, new FrozenClock(self::NOW));

        $this->manager->load(new Request(
            'GET',
            '/api/auth/session',
            ['cookie' => SessionCookie::fromArtifacts(TestEnvironment::artifacts(), true)->name() . '=' . $seeded->id],
        ));

        $current = $this->manager->current();
        self::assertNotNull($current);

        return $current;
    }
}
