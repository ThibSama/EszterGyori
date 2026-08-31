<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Auth\Session;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The admin content invariants of `http-contract.json` (Package 3.1).
 *
 * The counterpart of {@see \Eszter\Tests\Auth\AuthenticationTest} for
 * `/api/admin/content/*`. The executable corpus in
 * {@see HttpContractConformanceTest} covers everything expressible as one
 * request and one response; what is left — and what lives here — is the
 * behaviour that only shows up across *several* requests, or between a request
 * and the bytes on disk:
 *
 *  - a revision sequence is a sequence, so it takes a save, a publish and a
 *    reset in a row to show that it is one and only one;
 *  - "a publish invalidates both public surfaces" is a statement about what `/`
 *    and `/api/content` answer *afterwards*;
 *  - "a failed publish leaves no partial state" needs a failure injected in the
 *    middle of an operation, which no single well-formed request can produce.
 *
 * Every deployment here is real: a temp directory, real `draft.json` and
 * `published.json`, the real lock. Only the account directory and the session
 * store are doubles, for the same reason the conformance suite doubles them —
 * so the whole surface is provable without a MySQL server. Storage is precisely
 * what must *not* be faked, because atomic replacement, locking and the revision
 * sequence are the things under test.
 */
final class AdminContentTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    /** Invariant id => the test that proves it. */
    private const INVARIANT_TESTS = [
        'adminContent.revisionSequenceIsShared' =>
            'testTheRevisionSequenceIsSharedByDraftAndPublished',
        'adminContent.publishIsIdempotentAtAnUnchangedRevision' =>
            'testRepublishingAnUnchangedDraftChangesNothingACacheCanSee',
        'adminContent.publishInvalidatesBothPublicSurfaces' =>
            'testAPublishInvalidatesThePageAndTheContentEndpointTogether',
        'adminContent.publishReadsTheStoredDraftUnderOneLock' =>
            'testPublishIgnoresTheRequestBodyAndPublishesWhatIsStored',
        'adminContent.publishIsAllOrNothing' => 'testAFailedPublishLeavesThePreviousPublishedEnvelopeIntact',
        'adminContent.draftWritesAreAtomicAndBounded' => 'testDraftWritesAreAtomicAndLeaveNoTemporaryFile',
        'adminContent.savingADraftDoesNotTouchPublished' => 'testSavingADraftLeavesThePublicSiteExactlyAsItWas',
        'adminContent.resetNeverMutatesPublished' => 'testResettingTheDraftNeverMutatesPublishedContent',
        'adminContent.conflictLeavesStorageUntouched' => 'testAConflictWritesNothingAndReportsTheCurrentHead',
        'adminContent.rejectedRequestsNeverReachStorage' => 'testRejectedRequestsNeverReachStorage',
        'adminContent.conditionalHeadersAreIgnoredOnTheAdminSurface' => 'testConditionalRequestHeadersAreIgnored',
        'adminContent.adminResponsesAreNeverCacheable' => 'testEveryAdminContentResponseIsUncacheable',
        'adminContent.storageFailuresStayOpaque' => 'testAStorageFailureStaysOpaqueOnTheAdminSurface',
    ];

    private string $root;
    private Kernel $kernel;
    private InMemoryAccountDirectory $accounts;
    private InMemorySessionStore $sessions;
    private Session $session;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-admin-content');
        $this->boot();
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testEveryAdminContentInvariantHasATest(): void
    {
        /** @var list<array{id: string, description: string}> $invariants */
        $invariants = TestEnvironment::artifacts()->httpContract()['invariants'];

        $declared = [];
        foreach ($invariants as $invariant) {
            if (str_starts_with($invariant['id'], 'adminContent.')) {
                $declared[] = $invariant['id'];
            }
        }

        sort($declared);
        $covered = array_keys(self::INVARIANT_TESTS);
        sort($covered);

        // Equality in both directions, as in AuthenticationTest: an invariant the
        // contract declares must have a test here, and a mapping here must name
        // an invariant that still exists. Without the second half, a deleted
        // invariant leaves a test nobody realises is testing nothing.
        self::assertSame($declared, $covered);

        foreach (self::INVARIANT_TESTS as $invariant => $method) {
            self::assertTrue(method_exists($this, $method), "{$invariant} names a missing method");
        }
    }

    // ── The revision sequence ───────────────────────────────────────────────

    public function testTheRevisionSequenceIsSharedByDraftAndPublished(): void
    {
        // Seeded state: both at 0, both holding the canonical defaults.
        self::assertSame(0, $this->draftRevision());
        self::assertSame(0, $this->publishedRevision());

        // A save moves the head and leaves published where it was.
        $this->assertOk($this->save(0, $this->contentWithCopy('First edit')));
        self::assertSame(1, $this->draftRevision());
        self::assertSame(0, $this->publishedRevision());

        // A second save moves it again. The head is a sequence, not a flag.
        $this->assertOk($this->save(1, $this->contentWithCopy('Second edit')));
        self::assertSame(2, $this->draftRevision());
        self::assertSame(0, $this->publishedRevision());

        // A publish sets published.revision *to* the head it published — it does
        // not mint a third number — and leaves the draft alone.
        $this->assertOk($this->publish(2));
        self::assertSame(2, $this->draftRevision());
        self::assertSame(2, $this->publishedRevision());

        // A reset is a draft write like any other and moves the head.
        $this->assertOk($this->reset(2));
        self::assertSame(3, $this->draftRevision());
        self::assertSame(2, $this->publishedRevision());

        // The invariant, at every point above and here at the end.
        self::assertLessThanOrEqual($this->draftRevision(), $this->publishedRevision());
    }

    public function testRepublishingAnUnchangedDraftChangesNothingACacheCanSee(): void
    {
        $this->assertOk($this->save(0, $this->contentWithCopy('Published copy')));
        $this->assertOk($this->publish(1));

        $firstEtag = $this->publicEtag();
        $firstPublished = $this->storedPublished();

        // The retry an editor makes when a publish response never arrives.
        $this->assertOk($this->publish(1));

        self::assertSame(1, $this->publishedRevision());
        self::assertSame($firstEtag, $this->publicEtag(), 'a no-op republish invalidated caches');
        self::assertSame(
            $firstPublished['content'],
            $this->storedPublished()['content'],
            'the republished content differs from what was already published',
        );

        // `publishedAt` is allowed to move — and does — which is exactly what
        // `etag.derivedOnlyFromRevision` requires the validator to ignore.
        self::assertArrayHasKey('publishedAt', $this->storedPublished());
    }

    public function testAPublishInvalidatesThePageAndTheContentEndpointTogether(): void
    {
        $staleEtag = $this->publicEtag();

        // Both surfaces are satisfied by the current validator before the publish.
        self::assertSame(304, $this->conditionalGet('/api/content', $staleEtag)->status);
        self::assertSame(304, $this->conditionalGet('/', $staleEtag)->status);

        $this->assertOk($this->save(0, $this->contentWithCopy('Newly published copy')));
        $this->assertOk($this->publish(1));

        $freshEtag = $this->publicEtag();
        self::assertNotSame($staleEtag, $freshEtag, 'the published ETag survived a publish');
        self::assertSame('"published-1"', $freshEtag);

        // Neither surface answers 304 to the retired validator any more, and both
        // mint the same new one — so one publish invalidates them together rather
        // than leaving the page serving a cached document the API has moved past.
        self::assertSame(200, $this->conditionalGet('/api/content', $staleEtag)->status);
        self::assertSame(200, $this->conditionalGet('/', $staleEtag)->status);
        self::assertSame($freshEtag, $this->get('/')->header('ETag'));

        // And the new copy actually reached the public document.
        self::assertStringContainsString(
            'Newly published copy',
            (string) $this->get('/api/content')->body,
        );
    }

    public function testPublishIgnoresTheRequestBodyAndPublishesWhatIsStored(): void
    {
        $this->assertOk($this->save(0, $this->contentWithCopy('The stored draft')));

        // A body carrying content the caller would rather publish. The schema is
        // closed, so this is refused outright — publish cannot be talked into
        // taking a document that was never validated as a draft.
        $smuggled = $this->request('POST', '/api/admin/content/publish', [
            'expectedRevision' => 1,
            'content' => $this->contentWithCopy('Smuggled copy'),
        ]);

        self::assertSame(400, $smuggled->status);
        self::assertSame('VALIDATION_FAILED', $this->errorCode($smuggled));
        self::assertSame(0, $this->publishedRevision(), 'the rejected publish still published');

        // The legal publish takes the stored draft, not anything from the wire.
        $this->assertOk($this->publish(1));
        self::assertStringContainsString('The stored draft', (string) $this->get('/api/content')->body);
        self::assertStringNotContainsString('Smuggled copy', (string) $this->get('/api/content')->body);
    }

    public function testAFailedPublishLeavesThePreviousPublishedEnvelopeIntact(): void
    {
        $this->assertOk($this->save(0, $this->contentWithCopy('Good published copy')));
        $this->assertOk($this->publish(1));

        $publishedBefore = $this->rawPublished();
        $etagBefore = $this->publicEtag();

        // Corrupt the stored draft behind the service's back, the way a bad
        // deploy or a half-finished manual edit would. The draft is now
        // unpublishable, and the question is what that does to the *published*
        // document — which must be nothing at all.
        file_put_contents($this->root . '/data/content/draft.json', '{"schemaVersion":1,"revision":');

        $response = $this->publish(1);

        self::assertSame(500, $response->status);
        self::assertSame('STORAGE_FAILURE', $this->errorCode($response));

        // Byte-identical, not merely equivalent: the failure did not rewrite the
        // file, and no request in between could have seen a partial one.
        self::assertSame($publishedBefore, $this->rawPublished());
        self::assertSame($etagBefore, $this->publicEtag());
        self::assertSame([], $this->temporaryFiles(), 'a temp file survived the failed publish');

        // The public site keeps serving the last good publish throughout.
        self::assertSame(200, $this->get('/api/content')->status);
        self::assertStringContainsString(
            'Good published copy',
            (string) $this->get('/api/content')->body,
        );
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    public function testDraftWritesAreAtomicAndLeaveNoTemporaryFile(): void
    {
        $this->assertOk($this->save(0, $this->contentWithCopy('Atomic write')));

        // Nothing is left in var/tmp. A surviving temp file is not visible to a
        // reader, but it is the symptom of a write path that returned without
        // finishing, and it fills a disk quietly.
        self::assertSame([], $this->temporaryFiles());

        // The file that landed is complete and valid JSON, not a truncated one.
        $draft = $this->storedDraft();
        self::assertSame(1, $draft['revision']);
        self::assertStringContainsString('Atomic write', $this->rawDraft());

        // The size cap is still the storage layer's, unchanged by this route.
        self::assertLessThan(
            $this->kernel->storage->maxFileBytes(),
            \strlen($this->rawDraft()),
        );
    }

    public function testSavingADraftLeavesThePublicSiteExactlyAsItWas(): void
    {
        $publishedBefore = $this->rawPublished();
        $etagBefore = $this->publicEtag();
        $pageBefore = $this->get('/')->body;

        $this->assertOk($this->save(0, $this->contentWithCopy('Unpublished work in progress')));

        self::assertSame($publishedBefore, $this->rawPublished(), 'a save wrote to published.json');
        self::assertSame($etagBefore, $this->publicEtag(), 'a save moved the published ETag');
        self::assertSame($pageBefore, $this->get('/')->body, 'a save changed the public page');

        // The unpublished copy is readable through the admin route and nowhere else.
        self::assertStringContainsString(
            'Unpublished work in progress',
            (string) $this->get('/api/admin/content/draft', $this->authHeaders())->body,
        );
        self::assertStringNotContainsString(
            'Unpublished work in progress',
            (string) $this->get('/api/content')->body,
        );
    }

    public function testResettingTheDraftNeverMutatesPublishedContent(): void
    {
        $this->assertOk($this->save(0, $this->contentWithCopy('Published baseline')));
        $this->assertOk($this->publish(1));

        $publishedAfterPublish = $this->rawPublished();
        $etagAfterPublish = $this->publicEtag();

        // Work the editor then decides to throw away.
        $this->assertOk($this->save(1, $this->contentWithCopy('Regretted edit')));

        $response = $this->reset(2);
        $this->assertOk($response);

        // The draft now holds the published copy again, at the next revision.
        self::assertSame(3, $this->draftRevision());
        self::assertStringContainsString('Published baseline', $this->rawDraft());
        self::assertStringNotContainsString('Regretted edit', $this->rawDraft());

        // And published.json is byte-identical to before the reset: same content,
        // same revision, same publishedAt. Undoing an edit is not a republish.
        self::assertSame($publishedAfterPublish, $this->rawPublished());
        self::assertSame(1, $this->publishedRevision());
        self::assertSame($etagAfterPublish, $this->publicEtag());
    }

    // ── Refusals ────────────────────────────────────────────────────────────

    public function testAConflictWritesNothingAndReportsTheCurrentHead(): void
    {
        // Two editors read the same head; the first one saves.
        $this->assertOk($this->save(0, $this->contentWithCopy('First editor wins')));

        $draftBefore = $this->rawDraft();
        $publishedBefore = $this->rawPublished();

        // The second saves against the head it read, which has moved.
        foreach (
            [
                $this->save(0, $this->contentWithCopy('Second editor loses')),
                $this->publish(0),
                $this->reset(0),
            ] as $response
        ) {
            self::assertSame(409, $response->status);
            self::assertSame('REVISION_CONFLICT', $this->errorCode($response));

            // The head it lost to, so it can re-read, rebase and retry without a
            // second round trip to find out.
            self::assertSame('1', $response->header('x-content-revision'));

            // Byte-identical: a refused write is not a write.
            self::assertSame($draftBefore, $this->rawDraft());
            self::assertSame($publishedBefore, $this->rawPublished());
            self::assertSame([], $this->temporaryFiles());
        }

        // The first editor's work is intact and the loser's never landed.
        self::assertStringContainsString('First editor wins', $this->rawDraft());
        self::assertStringNotContainsString('Second editor loses', $this->rawDraft());
    }

    public function testRejectedRequestsNeverReachStorage(): void
    {
        $draftBefore = $this->rawDraft();
        $publishedBefore = $this->rawPublished();

        $anonymous = ['content-type' => 'application/json'];
        $body = (string) json_encode([
            'expectedRevision' => 0,
            'content' => $this->contentWithCopy('Never stored'),
        ]);

        $rejected = [
            // 401 — no session at all.
            new Request('PUT', '/api/admin/content/draft', $anonymous, $body),
            new Request('POST', '/api/admin/content/publish', $anonymous, '{"expectedRevision":0}'),
            // 403 — a live session, no token.
            new Request(
                'PUT',
                '/api/admin/content/draft',
                ['cookie' => $this->sessionCookie()] + $anonymous,
                $body,
            ),
            // 405 — a method the path does not answer.
            new Request('DELETE', '/api/admin/content/draft', $this->authHeaders()),
        ];

        foreach ($rejected as $request) {
            $response = $this->kernel->handle($request);

            self::assertContains($response->status, [401, 403, 405], $request->method . ' ' . $request->path);

            // No revision header: the request never took the lock, so it never
            // learned the head — and a rejected caller must not discover that
            // there is one.
            self::assertNull($response->header('x-content-revision'));
            self::assertSame($draftBefore, $this->rawDraft());
            self::assertSame($publishedBefore, $this->rawPublished());
        }
    }

    public function testConditionalRequestHeadersAreIgnored(): void
    {
        $this->assertOk($this->save(0, $this->contentWithCopy('Conditional headers')));

        /** @var array<string, mixed> $admin */
        $admin = TestEnvironment::artifacts()->adminContentContract();
        /** @var array<string, mixed> $concurrency */
        $concurrency = $admin['concurrency'];
        /** @var list<string> $ignored */
        $ignored = $concurrency['ignoredHeaders'];

        self::assertNotSame([], $ignored);

        foreach ($ignored as $header) {
            // A value that would be a *failing* precondition if it were honoured.
            // The read must answer 200 anyway: this surface has one precondition
            // and it is not in a header.
            $read = $this->get('/api/admin/content/draft', [$header => '"published-999"'] + $this->authHeaders());

            self::assertSame(200, $read->status, "{$header} was honoured on a read");
            self::assertNull($read->header('ETag'));

            // And a write is decided by expectedRevision alone. A stale
            // conditional header does not stop a correct save, and a matching one
            // does not rescue a stale save.
            $accepted = $this->request(
                'PUT',
                '/api/admin/content/draft',
                ['expectedRevision' => $this->draftRevision(), 'content' => $this->contentWithCopy("via {$header}")],
                [$header => '"published-999"'],
            );

            self::assertSame(200, $accepted->status, "{$header} blocked a correct save");

            $refused = $this->request(
                'PUT',
                '/api/admin/content/draft',
                ['expectedRevision' => 0, 'content' => $this->contentWithCopy('stale')],
                [$header => '*'],
            );

            self::assertSame(409, $refused->status, "{$header} rescued a stale save");
        }
    }

    public function testEveryAdminContentResponseIsUncacheable(): void
    {
        /** @var array<string, mixed> $admin */
        $admin = TestEnvironment::artifacts()->adminContentContract();
        /** @var string $expected */
        $expected = $admin['cacheControl'];

        $responses = [
            'read' => $this->get('/api/admin/content/draft', $this->authHeaders()),
            'save' => $this->save(0, $this->contentWithCopy('Cacheability')),
            'conflict' => $this->save(0, $this->contentWithCopy('Stale')),
            'publish' => $this->publish(1),
            'reset' => $this->reset(1),
        ];

        foreach ($responses as $label => $response) {
            self::assertSame($expected, $response->header('Cache-Control'), $label);

            // No published validator anywhere on this surface: only `/` and
            // `/api/content` mint one, and a second minter would be a second
            // thing to keep in step with the revision.
            self::assertNull($response->header('ETag'), $label);
        }
    }

    public function testAStorageFailureStaysOpaqueOnTheAdminSurface(): void
    {
        // A draft that exists but cannot be parsed. Strict fail-fast: it is never
        // repaired, replaced or bypassed.
        file_put_contents($this->root . '/data/content/draft.json', '{"schemaVersion":');

        foreach (
            [
                'read' => $this->get('/api/admin/content/draft', $this->authHeaders()),
                'save' => $this->save(0, $this->contentWithCopy('Anything')),
                'publish' => $this->publish(0),
                'reset' => $this->reset(0),
            ] as $label => $response
        ) {
            self::assertSame(500, $response->status, $label);
            self::assertSame('STORAGE_FAILURE', $this->errorCode($response), $label);

            foreach (
                [
                    'draft.json', 'published.json', $this->root, '.php', 'vendor',
                    'STORAGE_READ_FAILED', 'STORAGE_VALIDATION_FAILED', 'STORAGE_INVALID_JSON',
                    'Eszter\\', 'schemaVersion', 'schema.json', 'revision',
                ] as $needle
            ) {
                self::assertStringNotContainsString($needle, $response->body, "{$label}: {$needle}");
            }

            $body = $response->decodedBody();
            self::assertIsArray($body);
            self::assertSame(['error'], array_keys($body));
        }
    }

    // ── Fixture ─────────────────────────────────────────────────────────────

    private function boot(): void
    {
        $clock = new FrozenClock(self::NOW);
        $configPath = TestEnvironment::writeDeployment($this->root);
        TestEnvironment::writeExportedPage($this->root);

        $this->accounts = InMemoryAccountDirectory::withAccount(true);
        $this->sessions = new InMemorySessionStore($clock);

        $this->kernel = Kernel::boot(
            $configPath,
            $clock,
            null,
            null,
            $this->accounts,
            $this->sessions,
        );

        $account = $this->accounts->findByEmail(InMemoryAccountDirectory::EMAIL);
        self::assertNotNull($account);
        $this->session = $this->sessions->seed($account->id, $clock);

        // Both files present at revision 0, as every deployment is once it has
        // served a request. Seeding here rather than letting the first call do it
        // keeps "what did this request change?" answerable from the first assertion.
        $this->kernel->storage->initialize();
    }

    /** @return array<string, string> */
    private function authHeaders(): array
    {
        return [
            'cookie' => $this->sessionCookie(),
            'x-csrf-token' => $this->session->csrfToken,
        ];
    }

    private function sessionCookie(): string
    {
        /** @var array<string, mixed> $cookie */
        $cookie = TestEnvironment::artifacts()->authContract()['sessionCookie'];
        /** @var string $name */
        $name = $cookie['name'];

        return $name . '=' . $this->session->id;
    }

    /** @param array<string, string> $headers */
    private function get(string $path, array $headers = []): Response
    {
        return $this->kernel->handle(new Request('GET', $path, $headers));
    }

    private function conditionalGet(string $path, string $etag): Response
    {
        return $this->get($path, ['if-none-match' => $etag]);
    }

    /**
     * @param array<string, mixed> $payload
     * @param array<string, string> $headers
     */
    private function request(string $method, string $path, array $payload, array $headers = []): Response
    {
        return $this->kernel->handle(new Request(
            $method,
            $path,
            $headers + ['content-type' => 'application/json'] + $this->authHeaders(),
            (string) json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        ));
    }

    /** @param array<string, mixed> $content */
    private function save(int $expectedRevision, array $content): Response
    {
        return $this->request('PUT', '/api/admin/content/draft', [
            'expectedRevision' => $expectedRevision,
            'content' => $content,
        ]);
    }

    private function publish(int $expectedRevision): Response
    {
        return $this->request('POST', '/api/admin/content/publish', [
            'expectedRevision' => $expectedRevision,
        ]);
    }

    private function reset(int $expectedRevision): Response
    {
        return $this->request('POST', '/api/admin/content/reset', [
            'expectedRevision' => $expectedRevision,
            'source' => 'published',
        ]);
    }

    private function assertOk(Response $response): void
    {
        self::assertSame(200, $response->status, (string) $response->body);
    }

    private function errorCode(Response $response): string
    {
        $body = $response->decodedBody();
        self::assertIsArray($body);

        /** @var array{error: array{code: string}} $body */
        return $body['error']['code'];
    }

    /**
     * The canonical document with one visible string changed.
     *
     * A real edit rather than a synthetic one: it stays contract-valid, and the
     * changed string is what the assertions then look for on the wire and on
     * disk, so "did this reach the public site?" is answerable by searching for
     * it.
     *
     * `hero.description` rather than `hero.title` because the title is a
     * structured object — prefix, emphasized, suffix — and the description is the
     * plain string this needs.
     *
     * @return array<string, mixed>
     */
    private function contentWithCopy(string $copy): array
    {
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        /** @var array<string, mixed> $hero */
        $hero = $content['hero'];
        $hero['description'] = $copy;
        $content['hero'] = $hero;

        return $content;
    }

    private function publicEtag(): string
    {
        return (string) $this->get('/api/content')->header('ETag');
    }

    private function rawDraft(): string
    {
        return (string) file_get_contents($this->root . '/data/content/draft.json');
    }

    private function rawPublished(): string
    {
        return (string) file_get_contents($this->root . '/data/content/published.json');
    }

    /** @return array<string, mixed> */
    private function storedDraft(): array
    {
        return self::decode($this->rawDraft());
    }

    /** @return array<string, mixed> */
    private function storedPublished(): array
    {
        return self::decode($this->rawPublished());
    }

    /** @return array<string, mixed> */
    private static function decode(string $raw): array
    {
        /** @var mixed $decoded */
        $decoded = json_decode($raw, true);
        self::assertIsArray($decoded);

        /** @var array<string, mixed> */
        return $decoded;
    }

    private function draftRevision(): int
    {
        /** @var int $revision */
        $revision = $this->storedDraft()['revision'];

        return $revision;
    }

    private function publishedRevision(): int
    {
        /** @var int $revision */
        $revision = $this->storedPublished()['revision'];

        return $revision;
    }

    /** @return list<string> */
    private function temporaryFiles(): array
    {
        $entries = @scandir($this->root . '/var/tmp');

        if ($entries === false) {
            return [];
        }

        return array_values(array_filter(
            $entries,
            static fn (string $entry): bool => $entry !== '.' && $entry !== '..',
        ));
    }
}
