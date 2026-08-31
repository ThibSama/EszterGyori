<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\Request;
use Eszter\Http\RequestId;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Storage\PublishedContentReader;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The whole of `http-contract.json`, executed against the PHP front controller
 * (ESZ-015).
 *
 * This is the gate `php:http-contract`. It was written as the counterpart of the
 * Express suite `API/tests/http-contract.test.ts`, which read the same generated
 * artifact and asserted the same things, so "PHP conforms" means the same sentence
 * the reference meant rather than something weaker written in a second dialect.
 * That service was retired in ESZ-015 once this suite was green; the artifact it
 * replayed is unchanged, and this is now the only executable proof of the frozen
 * surface.
 *
 * ## Intentional differences are data, not skips
 *
 * A case this runtime is not required to satisfy carries an `exemptions` entry in
 * the artifact naming the implementation and the reason. That distinction is the
 * point of ESZ-015: a skipped test proves nothing and reads as an oversight,
 * whereas an exemption is a contract change, visible in a diff, and
 * {@see testTheExemptionSetIsExactlyWhatIsExpected()} fails if the set ever
 * widens. There is exactly one, and it exists because the PHP front controller is
 * mounted at `/api` and does not own `/`.
 *
 * Package 1.1 tracked the gap as a hard-coded list of pending case ids in
 * {@see HttpFoundationTest}. That list is gone: the cases now run.
 */
final class HttpContractConformanceTest extends TestCase
{
    private const IMPLEMENTATION = 'php';
    private const NOW = '2026-06-13T12:00:00.000Z';

    /**
     * Text baked into the fixture export's body, standing in for the canonical
     * copy `next build` writes there. It must survive injection: PHP rewrites two
     * elements and must leave the rest of the document alone.
     */
    private const BAKED_MARKER = 'BAKED-DEFAULT-COPY';

    private string $root;

    /**
     * The doubles the current case is running against, for the auth assertions.
     *
     * Assigned by {@see bootFor()} — or by {@see boot()} for the tests that call
     * it directly — before anything reads them, and reset in {@see setUp()} so one
     * case's seeded sessions cannot be visible to the next.
     */
    private InMemorySessionStore $sessionStore;
    private InMemoryAccountDirectory $accounts;

    /** The session id the request was made with, if the case established one. */
    private ?string $seededSessionId = null;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-conformance');
        unset($this->sessionStore, $this->accounts);
        $this->seededSessionId = null;
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    /** @return array<mixed> */
    private static function contract(): array
    {
        return TestEnvironment::artifacts()->httpContract();
    }

    /** @return list<array<mixed>> */
    private static function cases(): array
    {
        /** @var list<array<mixed>> $cases */
        $cases = self::contract()['cases'];

        return $cases;
    }

    /** The reason this implementation is exempt from a case, if it is. */
    private static function exemption(mixed $case): ?string
    {
        $exemptions = \is_array($case) ? ($case['exemptions'] ?? null) : null;

        if (!\is_array($exemptions)) {
            return null;
        }

        foreach ($exemptions as $exemption) {
            if (!\is_array($exemption) || ($exemption['implementation'] ?? null) !== self::IMPLEMENTATION) {
                continue;
            }

            /** @var mixed $reason */
            $reason = $exemption['reason'] ?? null;

            return \is_string($reason) ? $reason : '';
        }

        return null;
    }

    /** @return iterable<string, array{array<mixed>}> */
    public static function contractCases(): iterable
    {
        foreach (self::cases() as $case) {
            /** @var string $id */
            $id = $case['id'];

            yield $id => [$case];
        }
    }

    /** @param array<mixed> $case */
    #[DataProvider('contractCases')]
    public function testContractCase(array $case): void
    {
        $exemption = self::exemption($case);

        if ($exemption !== null) {
            self::markTestSkipped("Declared migration difference: {$exemption}");
        }

        /** @var array{method: string, path: string, headers?: array<string, string>, rawBody?: string} $request */
        $request = $case['request'];
        /** @var array<string, mixed> $expected */
        $expected = $case['expect'];

        $kernel = $this->bootFor($case);

        $before = $this->storedContent();

        $response = $kernel->handle(new Request(
            $request['method'],
            $request['path'],
            // The auth headers are merged *under* the case's own, so a case that
            // writes an explicit `cookie` — `auth.session.get.unknownSessionIdIsAnonymous`
            // does — keeps it.
            ($request['headers'] ?? []) + $this->authHeaders($case),
            $this->requestBody($request),
        ));

        self::assertSame($expected['status'], $response->status, 'status');

        $this->assertHeaders($expected, $response);
        $this->assertContentRevision($expected, $response);
        $this->assertStorageAfter($expected, $before);
        $this->assertSessionCookie($expected, $response);
        $requestId = $this->assertRequestId($case, $expected, $response);
        $this->assertBody($case, $expected, $response, $requestId);
    }

    public function testTheExemptionSetIsExactlyWhatIsExpected(): void
    {
        $exempt = [];
        foreach (self::cases() as $case) {
            if (self::exemption($case) !== null) {
                /** @var string $id */
                $id = $case['id'];
                $exempt[] = $id;
            }
        }

        // Empty since ESZ-021, and the change is worth reading as a sentence. The
        // one exemption that ever existed said `/` was not this service's to
        // answer: on the target host it was the static site, and the front
        // controller was mounted at `/api`. Package 2.1 removed the Node server
        // that used to serve it, so `/` became a contracted PHP endpoint and the
        // exemption stopped being true rather than being waived.
        //
        // This assertion is the reason to keep it empty: an exemption is a
        // contract change, visible in a diff, and never a way to quiet a runtime
        // that has stopped conforming.
        self::assertSame([], $exempt);
    }

    public function testTheSemanticFixtureIsSemanticOnly(): void
    {
        // `admin.draft.put.semanticallyInvalidContent` exists to prove the save
        // route runs the semantic rules and not merely the JSON Schema. It only
        // proves that while its fixture is structurally *valid* — otherwise the
        // schema rejects the document first and the case passes against a route
        // that never reached a rule.
        $artifacts = TestEnvironment::artifacts();
        $content = self::withSemanticViolation($artifacts->canonicalSiteContent());

        self::assertSame(
            [],
            (new StructuralValidator($artifacts))->validate($content, 'site-content.input.schema.json'),
            'the semantic fixture also breaks the structural schema',
        );

        // And it is genuinely rejected, so the case is not passing by accident.
        $result = ContentValidator::create($artifacts)
            ->validate($content, ContentValidator::TARGET_SITE_CONTENT);

        self::assertFalse($result->valid, 'the semantic fixture is not actually invalid');

        // The structural fixture is the mirror image: it must break the schema.
        self::assertNotSame(
            [],
            (new StructuralValidator($artifacts))->validate(
                self::withStructuralViolation($artifacts->canonicalSiteContent()),
                'site-content.input.schema.json',
            ),
            'the structural fixture does not break the structural schema',
        );
    }

    public function testEveryFrozenEndpointIsRouted(): void
    {
        /** @var list<array<mixed>> $endpoints */
        $endpoints = self::contract()['endpoints'];
        $paths = [];

        foreach ($endpoints as $endpoint) {
            /** @var string $path */
            $path = $endpoint['path'];
            $paths[] = $path;
        }

        $routed = $this->boot()->router->paths();
        sort($paths);
        sort($routed);

        // Equality in both directions: an endpoint the contract freezes must be
        // routed, and a path routed here must be one the contract freezes. The
        // second half is what keeps `/api/admin/*` and `/api/auth/*` at their
        // frozen 404 until they are contracted.
        self::assertSame($paths, $routed);
    }

    public function testHealthDoesNotDependOnContentStorage(): void
    {
        // Invariant `health.doesNotDependOnContentStorage`. Storage raises on
        // every read, and health must still answer 200 — an editor's bad publish
        // is not an outage.
        $kernel = $this->boot($this->reader('failure', 0));
        $response = $kernel->handle(new Request('GET', '/api/health'));

        self::assertSame(200, $response->status);
        self::assertSame(500, $kernel->handle(new Request('GET', '/api/content'))->status);

        // And it writes nothing: no seeding, no lock file, no content directory.
        self::assertFileDoesNotExist($this->root . '/data/content/published.json');
    }

    public function testEtagIsStableAcrossRequestsAndDerivedOnlyFromRevision(): void
    {
        // Invariants `etag.stableAcrossRequests` and `etag.derivedOnlyFromRevision`.
        $kernel = $this->boot($this->reader('ok', 21));

        $first = $kernel->handle(new Request('GET', '/api/content'));
        $second = $kernel->handle(new Request('GET', '/api/content'));

        self::assertSame('"published-21"', $first->header('ETag'));
        self::assertSame($first->header('ETag'), $second->header('ETag'));

        // Same revision, different publish timestamp: the validator must not leak
        // into the tag, or a republish at the same revision would break caches.
        $shifted = $this->boot(new FixturePublishedContentReader(
            TestEnvironment::artifacts(),
            'ok',
            21,
            '2027-01-01T00:00:00.000Z',
        ))->handle(new Request('GET', '/api/content'));

        self::assertSame($first->header('ETag'), $shifted->header('ETag'));
    }

    public function testALegacyEnvelopeWithoutAppearanceIsNormalisedWithoutChangingTheEtag(): void
    {
        // Invariant `content.legacyAppearanceNormalized`.
        $artifacts = TestEnvironment::artifacts();
        $content = $artifacts->canonicalSiteContent();
        unset($content['appearance']);

        $response = $this->boot(new class ($content) implements PublishedContentReader {
            /** @param array<string, mixed> $content */
            public function __construct(private readonly array $content)
            {
            }

            /** @return array<string, mixed> */
            public function readPublished(): array
            {
                return [
                    'schemaVersion' => 1,
                    'revision' => 15,
                    'publishedAt' => '2026-06-13T12:00:00.000Z',
                    'content' => $this->content,
                ];
            }
        })->handle(new Request('GET', '/api/content'));

        $body = $response->decodedBody();

        self::assertSame(200, $response->status);
        self::assertSame('"published-15"', $response->header('ETag'));
        self::assertIsArray($body);
        self::assertSame(
            $artifacts->canonicalSiteContent()['appearance'],
            $body['content']['appearance'],
        );
    }

    public function testThePageAndTheContentEndpointShareOneCacheIdentity(): void
    {
        // Invariant `page.etagMatchesContentEndpoint`. This is what makes a single
        // publish invalidate both surfaces at once. If they ever drifted, the most
        // likely symptom is the ugly one: `/api/content` serves the new document
        // while `/` keeps answering 304 from a tag minted differently, and the site
        // looks like publishing silently failed.
        $kernel = $this->boot($this->reader('ok', 21));

        $page = $kernel->handle(new Request('GET', '/'));
        $api = $kernel->handle(new Request('GET', '/api/content'));

        self::assertSame('"published-21"', $page->header('ETag'));
        self::assertSame($api->header('ETag'), $page->header('ETag'));
        self::assertSame($api->header('Cache-Control'), $page->header('Cache-Control'));

        // And the tag the page mints actually satisfies its own conditional
        // request, rather than merely looking right in a header.
        $revalidated = $kernel->handle(new Request(
            'GET',
            '/',
            ['if-none-match' => (string) $page->header('ETag')],
        ));

        self::assertSame(304, $revalidated->status);
        self::assertSame('', $revalidated->body);
    }

    public function testTheSameContentReachesThePageAndTheApi(): void
    {
        // Injecting is not re-authoring: the document in the HTML must be the same
        // one the API serves, not a reshaped copy. Proving it here is what allows
        // `PublicPageBootstrap` to stay a text substitution rather than growing
        // into a second serializer.
        $kernel = $this->boot($this->reader('ok', 5));

        $page = $kernel->handle(new Request('GET', '/'));
        $api = $kernel->handle(new Request('GET', '/api/content'));

        $injected = json_decode($this->bootstrapPayload($page->body), true);

        self::assertIsArray($injected);
        self::assertSame($api->decodedBody(), $injected);
    }

    public function testAPublishChangesThePageWithoutRebuildingTheFrontend(): void
    {
        // ESZ-021's acceptance criterion, stated as a test. The exported file on
        // disk never changes; only the stored revision does, and the page follows.
        $before = $this->boot($this->reader('ok', 1))->handle(new Request('GET', '/'));
        $exportedAfterFirstRequest = (string) file_get_contents($this->root . '/public_html/index.html');

        $after = $this->boot($this->reader('ok', 2))->handle(new Request('GET', '/'));

        self::assertSame('"published-1"', $before->header('ETag'));
        self::assertSame('"published-2"', $after->header('ETag'));
        self::assertNotSame($before->body, $after->body);

        // The build artifact is untouched. Publishing edits `data/`, never the
        // document root, which is also why a deploy can replace the export freely.
        self::assertSame(
            $exportedAfterFirstRequest,
            file_get_contents($this->root . '/public_html/index.html'),
            'serving the page rewrote the exported file',
        );
    }

    public function testAMissingExportIsTheOneFailureThePageCannotDegradeThrough(): void
    {
        // Everything else about `/` degrades to the baked defaults. This cannot:
        // there is no page to fall back *to*. It is a deploy fault, and it surfaces
        // as the opaque 500 rather than as an invented empty document.
        $configPath = TestEnvironment::writeDeployment($this->root);
        TestEnvironment::writeExportedPage($this->root, self::BAKED_MARKER);
        unlink($this->root . '/public_html/index.html');

        $response = Kernel::boot($configPath, new FrozenClock(self::NOW), $this->reader('ok', 3))
            ->handle(new Request('GET', '/'));

        $body = $response->decodedBody();

        self::assertSame(500, $response->status);
        self::assertIsArray($body);
        self::assertSame('STORAGE_FAILURE', $body['error']['code']);
        self::assertStringNotContainsString($this->root, $response->body);
    }

    public function testErrorsLeakNothing(): void
    {
        // Invariant `errors.leakNothing`.
        foreach (['failure', 'malformed'] as $storage) {
            $response = $this->boot($this->reader($storage, 0))
                ->handle(new Request('GET', '/api/content'));

            self::assertSame(500, $response->status, $storage);

            foreach (
                [
                    // Paths and file names.
                    'published.json', 'draft.json', $this->root, '.php', 'vendor',
                    // Internal storage codes — as distinct from the contract's own
                    // STORAGE_FAILURE, which the body is required to carry.
                    'STORAGE_READ_FAILED', 'STORAGE_VALIDATION_FAILED', 'STORAGE_INVALID_JSON',
                    // Class names and schema internals.
                    'Eszter\\', 'schemaVersion', 'schema.json', 'revision',
                ] as $needle
            ) {
                self::assertStringNotContainsString($needle, $response->body, $storage);
            }

            $body = $response->decodedBody();
            self::assertIsArray($body);
            self::assertSame(['error'], array_keys($body));
            self::assertSame(['code', 'message', 'requestId'], array_keys($body['error']));
        }
    }

    public function testAnOverLimitBodyIsRejectedRegardlessOfPathOrContentType(): void
    {
        // Invariant `body.overLimitRejected`, frozen in Package 1.2. Built here
        // rather than inlined in the artifact: a 64 kB literal would bloat every
        // consumer of http-contract.json to prove one number.
        /** @var array<string, mixed> $outcome */
        $outcome = self::contract()['overLimitBody'];
        $limit = Kernel::parseByteSize(self::contract()['requestBodyLimitBytes']);
        $oversized = str_repeat('x', $limit + 1);
        $kernel = $this->boot();

        foreach (['application/json', 'text/plain'] as $contentType) {
            foreach (['/api/health', '/api/content', '/api/unknown'] as $path) {
                $response = $kernel->handle(new Request(
                    'POST',
                    $path,
                    ['content-type' => $contentType],
                    $oversized,
                ));

                $body = $response->decodedBody();

                self::assertSame($outcome['status'], $response->status, "{$contentType} {$path}");
                self::assertIsArray($body);
                self::assertSame($outcome['errorCode'], $body['error']['code'], "{$contentType} {$path}");
            }
        }
    }

    public function testABootstrapFailureAnswersTheFrozenEnvelope(): void
    {
        // Invariant `bootstrap.failureUsesFrozenEnvelope`. Only observable on a
        // per-request runtime, which is why the contract states it separately from
        // the per-endpoint status lists.
        /** @var array<string, mixed> $frozen */
        $frozen = self::contract()['bootstrapFailure'];

        $path = TestEnvironment::writeDeployment(
            $this->root,
            ['paths' => ['contracts' => $this->root . '/no-contracts']],
        );

        $response = Kernel::respond(
            $path,
            new Request('GET', '/api/health', ['x-request-id' => 'req_boot.probe']),
        );
        $body = $response->decodedBody();

        self::assertSame($frozen['status'], $response->status);
        self::assertIsArray($body);
        self::assertSame('INVALID_CONFIGURATION', $body['error']['code']);

        // The frozen envelope, a request id under the normal trusted-inbound
        // rules, no leaked path, and no published validator.
        self::assertSame(['code', 'message', 'requestId'], array_keys($body['error']));
        self::assertSame('req_boot.probe', $response->header(RequestId::HEADER));
        self::assertSame('req_boot.probe', $body['error']['requestId']);
        self::assertStringNotContainsString($this->root, $response->body);
        self::assertNull($response->header('ETag'));

        // The message is the contract's copy, never retyped in PHP.
        /** @var array<string, string> $messages */
        $messages = self::contract()['errorMessages'];
        self::assertSame($messages['INVALID_CONFIGURATION'], $body['error']['message']);
    }

    public function testAnUnsafeInboundRequestIdIsReplacedEvenOnABootstrapFailure(): void
    {
        $path = TestEnvironment::writeDeployment(
            $this->root,
            ['paths' => ['contracts' => $this->root . '/no-contracts']],
        );

        $response = Kernel::respond(
            $path,
            new Request('GET', '/api/health', ['x-request-id' => "../unsafe\r\nX-Injected: 1"]),
        );

        $requestId = $response->header(RequestId::HEADER);

        self::assertIsString($requestId);
        self::assertStringStartsWith('req_', $requestId);
        self::assertStringNotContainsString('X-Injected', $requestId);
    }

    // --- helpers -----------------------------------------------------------

    private function reader(string $storage, int $revision): PublishedContentReader
    {
        return new FixturePublishedContentReader(TestEnvironment::artifacts(), $storage, $revision);
    }

    /** @param array<mixed> $case */
    private function bootFor(array $case): Kernel
    {
        /** @var mixed $storage */
        $storage = $case['storage'] ?? null;
        /** @var mixed $revision */
        $revision = $case['publishedRevision'] ?? null;

        /** @var mixed $auth */
        $auth = $case['auth'] ?? null;
        /** @var array<string, mixed> $auth */
        $auth = \is_array($auth) ? $auth : [];

        // `auth.account` decides what the directory holds. `missing` is an empty
        // directory rather than a directory with a different address in it,
        // because "no such account" is the state the case names.
        $this->accounts = match ($auth['account'] ?? null) {
            'enabled' => InMemoryAccountDirectory::withAccount(true),
            'disabled' => InMemoryAccountDirectory::withAccount(false),
            default => InMemoryAccountDirectory::empty(),
        };

        $clock = new FrozenClock(self::NOW);
        $this->sessionStore = new InMemorySessionStore($clock);

        $kernel = $this->boot(
            $this->reader(
                \is_string($storage) ? $storage : 'ok',
                \is_int($revision) ? $revision : 0,
            ),
        );

        // `auth.session` is established by writing the row a previous request
        // would have left, not by driving the API — the point is to control the
        // starting state exactly, including its id and its token.
        $session = match ($auth['session'] ?? 'none') {
            'anonymous' => $this->sessionStore->seed(null, $clock),
            // A case that names an authenticated session but no account —
            // `auth.logout.post.*` do exactly that — still needs one to attach
            // the session to, so an enabled account is created on demand.
            'authenticated' => $this->sessionStore->seed(
                ($this->accounts->findByEmail(InMemoryAccountDirectory::EMAIL)
                    ?? $this->accounts->add(
                        InMemoryAccountDirectory::EMAIL,
                        InMemoryAccountDirectory::PASSWORD,
                        true,
                    ))->id,
                $clock,
            ),
            default => null,
        };

        $this->seededSessionId = $session?->id;

        // The admin content cases are about what a request *changes*, so storage
        // has to already exist for "unchanged" to mean anything. Seeding it here
        // rather than letting the first request do it also matches the state
        // every real deployment is in after it has served once: both files
        // present, both at revision 0, both holding the canonical defaults.
        if (str_starts_with($this->casePath($case), '/api/admin/content/')) {
            $kernel->storage->initialize();
        }

        return $kernel;
    }

    /** @param array<mixed> $case */
    private function casePath(array $case): string
    {
        /** @var array{path?: string} $request */
        $request = $case['request'] ?? [];

        return $request['path'] ?? '';
    }

    /**
     * The cookie and CSRF headers for a case's `auth` block.
     *
     * `csrf: "valid"` is resolved to the token the seeded session actually holds.
     * Writing a literal token into the artifact instead would only be possible if
     * the check accepted a constant, which is the bug the case exists to catch.
     *
     * @param array<mixed> $case
     * @return array<string, string>
     */
    private function authHeaders(array $case): array
    {
        /** @var mixed $auth */
        $auth = $case['auth'] ?? null;

        if (!\is_array($auth)) {
            return [];
        }

        $headers = [];
        $session = $this->seededSessionId === null
            ? null
            : ($this->sessionStore->sessions[$this->seededSessionId] ?? null);

        if ($session !== null) {
            $headers['cookie'] = self::sessionCookieName() . '=' . $session->id;
        }

        /** @var array<string, mixed> $csrfBlock */
        $csrfBlock = self::contract()['auth']['csrf'];
        /** @var string $csrfHeader */
        $csrfHeader = $csrfBlock['header'];

        $token = match ($auth['csrf'] ?? 'omitted') {
            'valid' => $session === null ? '' : $session->csrfToken,
            'empty' => '',
            // Well-formed and belonging to no session: the shape is right, so a
            // check that only validated the shape would pass this.
            'wrong' => str_repeat('a', 64),
            default => null,
        };

        if ($token !== null) {
            $headers[$csrfHeader] = $token;
        }

        return $headers;
    }

    /**
     * The bytes a case sends.
     *
     * `rawBody` goes out verbatim — that is how the malformed-JSON cases work. A
     * named `body` is *built* here instead, from the canonical document the
     * artifacts already carry, because a valid `SiteContent` is about 8 kB of
     * JSON and writing several of them into `http-contract.json` as literals
     * would multiply the size of a file every implementation has to parse.
     *
     * The match is exhaustive with no default: an unrecognised name fails the
     * case loudly rather than sending an empty body and reporting whatever the
     * route does with nothing.
     *
     * @param array{
     *     method: string,
     *     path: string,
     *     headers?: array<string, string>,
     *     rawBody?: string,
     *     body?: string,
     * } $request
     */
    private function requestBody(array $request): string
    {
        if (isset($request['rawBody'])) {
            return $request['rawBody'];
        }

        $name = $request['body'] ?? null;

        if ($name === null) {
            return '';
        }

        $artifacts = TestEnvironment::artifacts();
        $content = $artifacts->canonicalSiteContent();
        $stale = self::staleRevisionFixture();

        $payload = match ($name) {
            'draftSave.valid' => ['expectedRevision' => 0, 'content' => $content],
            'draftSave.staleRevision' => ['expectedRevision' => $stale, 'content' => $content],
            // Structurally intact — the key exists and is a string — but breaking
            // a declared semantic rule, so a runtime that only ran JSON Schema
            // would accept it. That is the case's whole point.
            'draftSave.semanticallyInvalidContent' => [
                'expectedRevision' => 0,
                'content' => self::withSemanticViolation($content),
            ],

            // Wrong *type* for a required field, which JSON Schema alone catches.
            'draftSave.structurallyInvalidContent' => [
                'expectedRevision' => 0,
                'content' => self::withStructuralViolation($content),
            ],
            'draftSave.missingContent' => ['expectedRevision' => 0],
            'draftSave.unknownField' => [
                'expectedRevision' => 0,
                'content' => $content,
                'publish' => true,
            ],
            'draftSave.missingExpectedRevision' => ['content' => $content],
            'publish.valid' => ['expectedRevision' => 0],
            'publish.staleRevision' => ['expectedRevision' => $stale],
            'publish.missingExpectedRevision' => [],
            'reset.valid' => ['expectedRevision' => 0, 'source' => 'published'],
            'reset.staleRevision' => ['expectedRevision' => $stale, 'source' => 'published'],
            'reset.unknownSource' => ['expectedRevision' => 0, 'source' => 'defaults'],
            'reset.missingSource' => ['expectedRevision' => 0],
            'mediaDelete.unknownId' => ['id' => self::unknownMediaIdFixture()],
            // Well-formed JSON, wrong shape for an id. The request schema must
            // refuse it as 400 before it can reach the catalogue; only a
            // well-formed id that is absent there is 404.
            'mediaDelete.malformedId' => ['id' => 'not-a-media-id'],
            // A path fragment inside a field the schema pins to `[0-9a-f]`. It
            // must never reach a filesystem call, and the pattern is what stops
            // it — not a sanitiser downstream.
            'mediaDelete.traversalId' => ['id' => '../../etc/passwd'],
            'mediaDelete.missingId' => [],
            default => self::fail("Unknown named request body: {$name}"),
        };

        return (string) json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    private static function unknownMediaIdFixture(): string
    {
        /** @var array<string, mixed> $media */
        $media = self::contract()['media'];
        /** @var string $id */
        $id = $media['unknownAssetIdFixture'];

        return $id;
    }

    private static function staleRevisionFixture(): int
    {
        /** @var array<string, mixed> $admin */
        $admin = self::contract()['adminContent'];
        /** @var int $stale */
        $stale = $admin['staleRevisionFixture'];

        return $stale;
    }

    /**
     * Canonical content with one semantic rule broken and its structure intact.
     *
     * `links.instagramHttpsHost` is declared in `semantic-rules.json` and has no
     * JSON Schema equivalent: the value below is still a string, still a URL, and
     * still `https:`, so every structural constraint on the field is satisfied
     * and only the declared rule rejects it. That is what makes this case prove
     * the semantic layer actually runs on a save — a fixture that also broke the
     * schema would pass this test against a route that never ran a rule at all.
     *
     * {@see testTheSemanticFixtureIsSemanticOnly} holds that property in place.
     *
     * @param array<string, mixed> $content
     * @return array<string, mixed>
     */
    private static function withSemanticViolation(array $content): array
    {
        /** @var array<string, mixed> $contact */
        $contact = $content['contact'];
        /** @var array<string, mixed> $cta */
        $cta = $contact['instagramCta'];
        $cta['href'] = 'https://not-instagram.example.com/eszter';
        $contact['instagramCta'] = $cta;
        $content['contact'] = $contact;

        return $content;
    }

    /**
     * Canonical content with a required field of the wrong type.
     *
     * @param array<string, mixed> $content
     * @return array<string, mixed>
     */
    private static function withStructuralViolation(array $content): array
    {
        /** @var array<string, mixed> $hero */
        $hero = $content['hero'] ?? [];
        $hero['title'] = 42;
        $content['hero'] = $hero;

        return $content;
    }

    /**
     * Asserts `expect.contentRevision`.
     *
     * The `absent` half is the load-bearing one: it is what proves a 401 or a 403
     * never reached storage. A rejected caller must not be able to learn the head
     * — or that there is one — from a response it was not entitled to.
     *
     * @param array<string, mixed> $expected
     */
    private function assertContentRevision(array $expected, Response $response): void
    {
        /** @var mixed $expectation */
        $expectation = $expected['contentRevision'] ?? null;

        if ($expectation === null) {
            return;
        }

        /** @var array<string, mixed> $admin */
        $admin = self::contract()['adminContent'];
        /** @var string $header */
        $header = $admin['revisionHeader'];
        $value = $response->header($header);

        if ($expectation === 'absent') {
            self::assertNull($value, "{$header} must not be sent on this response");

            return;
        }

        self::assertSame((string) $expectation, $value, $header);
    }

    /**
     * Both stored envelopes, verbatim, or null where the file does not exist yet.
     *
     * Read as raw bytes rather than through the storage layer on purpose: the
     * assertion these feed is "nothing changed", and re-reading through a
     * validator that normalises would compare normalised forms and could call a
     * rewritten file unchanged.
     *
     * @return array{draft: string|null, published: string|null}
     */
    private function storedContent(): array
    {
        $read = static function (string $path): ?string {
            $raw = is_file($path) ? @file_get_contents($path) : false;

            return $raw === false ? null : $raw;
        };

        return [
            'draft' => $read($this->root . '/data/content/draft.json'),
            'published' => $read($this->root . '/data/content/published.json'),
        ];
    }

    /**
     * Asserts `expect.storageAfter`.
     *
     * This is what turns "a conflict writes nothing" and "reset never touches
     * published" from sentences in the contract into things a failing test can
     * report. Byte comparison, not semantic comparison: a rejected request must
     * not rewrite a file even to an equivalent one, because a rewrite is a write
     * and the guarantee is that there was none.
     *
     * @param array<string, mixed> $expected
     * @param array{draft: string|null, published: string|null} $before
     */
    private function assertStorageAfter(array $expected, array $before): void
    {
        /** @var mixed $expectation */
        $expectation = $expected['storageAfter'] ?? null;

        if ($expectation === null) {
            return;
        }

        $after = $this->storedContent();

        if ($expectation === 'unchanged') {
            self::assertSame($before['draft'], $after['draft'], 'draft.json changed');
            self::assertSame($before['published'], $after['published'], 'published.json changed');
            self::assertSame([], $this->temporaryFiles(), 'a temp file was left behind');

            return;
        }

        if ($expectation === 'draftAdvanced') {
            $draft = self::decodeStored($after['draft'], 'draft');
            $published = self::decodeStored($after['published'], 'published');

            self::assertGreaterThan(
                self::decodeStored($before['draft'], 'draft')['revision'] ?? -1,
                $draft['revision'],
                'the draft revision did not advance',
            );

            // `content.savingADraftDoesNotTouchPublished` and
            // `content.resetNeverMutatesPublished` share this line: whatever the
            // draft did, the public document is byte-identical afterwards.
            self::assertSame($before['published'], $after['published'], 'published.json changed');

            // The shared-sequence invariant, asserted on every draft write.
            self::assertLessThanOrEqual(
                $draft['revision'],
                $published['revision'],
                'published.revision overtook the draft head',
            );

            return;
        }

        if ($expectation === 'publishedMatchesDraft') {
            $draft = self::decodeStored($after['draft'], 'draft');
            $published = self::decodeStored($after['published'], 'published');

            // `contentRevisionSemantics`: publish sets published.revision *to* the
            // draft head it published rather than incrementing a counter of its own.
            self::assertSame(
                $draft['revision'],
                $published['revision'],
                'the published revision is not the draft head that was published',
            );
            self::assertSame(
                $draft['content'],
                $published['content'],
                'the published content is not the draft content',
            );
            self::assertSame($before['draft'], $after['draft'], 'publishing modified the draft');

            return;
        }

        self::fail("Unknown storageAfter expectation: {$expectation}");
    }

    /** @return array<string, mixed> */
    private static function decodeStored(?string $raw, string $role): array
    {
        self::assertIsString($raw, "{$role}.json does not exist");
        /** @var mixed $decoded */
        $decoded = json_decode($raw, true);
        self::assertIsArray($decoded, "{$role}.json is not a JSON object");

        /** @var array<string, mixed> */
        return $decoded;
    }

    /**
     * Whatever is sitting in `var/tmp/`.
     *
     * A failed atomic write must clean up after itself. A surviving temp file is
     * not a correctness bug on its own — no reader can see it — but it is the
     * visible symptom of a write path that returned without finishing, and it
     * fills a disk quietly.
     *
     * @return list<string>
     */
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

    private static function adminCacheControl(): string
    {
        /** @var array<string, mixed> $admin */
        $admin = self::contract()['adminContent'];
        /** @var string $cacheControl */
        $cacheControl = $admin['cacheControl'];

        return $cacheControl;
    }

    private static function sessionCookieName(): string
    {
        /** @var array<string, mixed> $cookie */
        $cookie = self::contract()['auth']['sessionCookie'];
        /** @var string $name */
        $name = $cookie['name'];

        return $name;
    }

    /**
     * Asserts `expect.sessionCookie`.
     *
     * The `absent` case is the load-bearing one: it is what proves a rejected
     * login or a refused CSRF check does not quietly hand the caller a session.
     *
     * @param array<string, mixed> $expected
     */
    private function assertSessionCookie(array $expected, Response $response): void
    {
        /** @var mixed $expectation */
        $expectation = $expected['sessionCookie'] ?? null;

        if ($expectation === null) {
            return;
        }

        $setCookie = $response->header('Set-Cookie');

        if ($expectation === 'absent') {
            self::assertNull($setCookie, 'the response must not set a session cookie');

            return;
        }

        self::assertIsString($setCookie, 'the response sets no session cookie');
        self::assertStringStartsWith(self::sessionCookieName() . '=', $setCookie);

        // `auth.sessionCookieCarriesItsAttributes`, checked on every cookie the
        // contract expects rather than once in a dedicated test.
        self::assertStringContainsString('HttpOnly', $setCookie);
        self::assertStringContainsString('SameSite=Strict', $setCookie);
        self::assertStringContainsString('Path=/', $setCookie);
        self::assertStringContainsString('Secure', $setCookie);
        self::assertStringNotContainsStringIgnoringCase('Domain=', $setCookie);

        if ($expectation === 'cleared') {
            self::assertStringContainsString('Max-Age=0', $setCookie);
            self::assertStringContainsString(self::sessionCookieName() . '=;', $setCookie);

            return;
        }

        // `rotated`: a new id, and not the one the request carried.
        preg_match('/^' . preg_quote(self::sessionCookieName(), '/') . '=([^;]+)/', $setCookie, $match);
        self::assertNotSame('', $match[1] ?? '');
        self::assertNotSame($this->seededSessionId, $match[1]);
    }

    private function boot(?PublishedContentReader $reader = null): Kernel
    {
        $configPath = TestEnvironment::writeDeployment($this->root);

        // `/` reads the exported page out of the document root, so a deployment
        // without one has no page to serve. Written per boot rather than once, so
        // a case that rewrites it cannot leak into the next.
        TestEnvironment::writeExportedPage($this->root, self::BAKED_MARKER);

        $clock = new FrozenClock(self::NOW);
        $this->accounts ??= InMemoryAccountDirectory::empty();
        $this->sessionStore ??= new InMemorySessionStore($clock);

        return Kernel::boot(
            $configPath,
            $clock,
            $reader ?? $this->reader('ok', 0),
            null,
            $this->accounts,
            $this->sessionStore,
            null,
            new InMemoryBookingApi(),
        );
    }

    /** @param array<string, mixed> $expected */
    private function assertHeaders(array $expected, Response $response): void
    {
        /** @var array<string, string> $headers */
        $headers = $expected['headers'] ?? [];
        foreach ($headers as $name => $value) {
            self::assertSame($value, $response->header($name), "header {$name}");
        }

        /** @var array<string, string> $patterns */
        $patterns = $expected['headerPatterns'] ?? [];
        foreach ($patterns as $name => $pattern) {
            self::assertMatchesRegularExpression(
                '#' . str_replace('#', '\\#', $pattern) . '#',
                (string) $response->header($name),
                "header {$name}",
            );
        }

        /** @var array<string, string> $forbidden */
        $forbidden = $expected['forbiddenHeaderPatterns'] ?? [];
        foreach ($forbidden as $name => $pattern) {
            self::assertDoesNotMatchRegularExpression(
                '#' . str_replace('#', '\\#', $pattern) . '#',
                (string) $response->header($name),
                "header {$name} must not match {$pattern}",
            );
        }
    }

    /**
     * @param array<mixed> $case
     * @param array<string, mixed> $expected
     */
    private function assertRequestId(array $case, array $expected, Response $response): string
    {
        $requestId = $response->header(RequestId::HEADER);

        // `requestId.presentOnEveryResponse` — asserted on every case, not only
        // the ones that name an expectation, including 304 and 500.
        self::assertIsString($requestId, 'every response carries X-Request-Id');

        /** @var array<string, string> $requestHeaders */
        $requestHeaders = $case['request']['headers'] ?? [];
        $inbound = $requestHeaders['x-request-id'] ?? null;

        /** @var mixed $expectation */
        $expectation = $expected['requestId'] ?? null;

        if ($expectation === 'echoesRequest') {
            self::assertSame($inbound, $requestId);
        }

        if ($expectation === 'generated') {
            /** @var array<string, string> $spec */
            $spec = self::contract()['requestId'];
            self::assertStringStartsWith($spec['generatedPrefix'], $requestId);
            self::assertNotSame($inbound, $requestId);
        }

        return $requestId;
    }

    /**
     * @param array<mixed> $case
     * @param array<string, mixed> $expected
     */
    private function assertBody(
        array $case,
        array $expected,
        Response $response,
        string $requestId,
    ): void {
        $artifacts = TestEnvironment::artifacts();
        $structural = new StructuralValidator($artifacts);
        $body = $response->decodedBody();

        switch ($expected['body']) {
            case 'empty':
                self::assertSame('', $response->body, 'a 304 carries no body at all');
                break;

            case 'healthResponse':
                self::assertIsArray($body);
                self::assertSame([], $structural->validate($body, 'health-response.schema.json'));
                // The schema is closed, so this also proves `uptimeSeconds` — removed
                // from the contract in Package 1.2 — has not crept back in.
                self::assertArrayNotHasKey('uptimeSeconds', $body);
                self::assertSame(self::NOW, $body['timestamp']);
                break;

            case 'publishedContentEnvelope':
                self::assertIsArray($body);
                self::assertSame(
                    [],
                    $structural->validate($body, 'published-content-envelope.output.schema.json'),
                );
                self::assertSame($artifacts->contentSchemaVersion(), $body['schemaVersion']);
                if (\array_key_exists('publishedRevision', $case)) {
                    self::assertSame($case['publishedRevision'], $body['revision']);
                }
                break;

            case 'serverDraftEnvelope':
                self::assertIsArray($body);
                self::assertSame(
                    [],
                    $structural->validate($body, 'server-draft-envelope.output.schema.json'),
                );
                self::assertSame($artifacts->contentSchemaVersion(), $body['schemaVersion']);

                // The draft is unpublished editorial work. It must not be
                // storable by a browser or an intermediary, and it must not carry
                // a second revision token a client could send back as a
                // precondition this surface ignores.
                self::assertSame(
                    self::adminCacheControl(),
                    $response->header('Cache-Control'),
                    'the draft response is cacheable',
                );
                self::assertNull($response->header('ETag'), 'the draft response carries an ETag');
                break;

            case 'errorEnvelope':
                self::assertIsArray($body);
                self::assertSame([], $structural->validate($body, 'error-envelope.schema.json'));
                self::assertSame($expected['errorCode'], $body['error']['code']);
                // `requestId.presentOnEveryResponse`: the body repeats the header.
                self::assertSame($requestId, $body['error']['requestId']);
                self::assertContains($body['error']['code'], self::contract()['errorCodes']);
                break;

            case 'publicPageHtml':
                $this->assertPublicPage($case, $expected, $response);
                break;

            case 'mediaLibraryResponse':
            case 'mediaUploadResponse':
                self::assertIsArray($body);
                self::assertSame([], $structural->validate(
                    $body,
                    $expected['body'] === 'mediaLibraryResponse'
                        ? 'media-library-response.schema.json'
                        : 'media-upload-response.schema.json',
                ));

                // Same rule as the draft: an asset list is a map of unpublished
                // editorial work and must not be storable by a browser or a proxy.
                self::assertSame(
                    self::adminCacheControl(),
                    $response->header('Cache-Control'),
                    'the media response is cacheable',
                );
                self::assertNull($response->header('ETag'), 'the media response carries an ETag');

                // `media.responsesNeverNameServerPaths`. The schemas are strict, so
                // an unexpected key is already rejected; this catches the worse
                // mistake of a server path arriving inside a declared one.
                self::assertStringNotContainsString($this->root, $response->body);
                self::assertStringNotContainsString('media-originals', $response->body);
                self::assertStringNotContainsString('.intake', $response->body);
                self::assertStringNotContainsString('.staging-', $response->body);
                break;

            case 'publicBookableServicesResponse':
            case 'bookingAvailabilityResponse':
            case 'publicBookingResponse':
            case 'adminBookingsResponse':
            case 'adminBookingResponse':
            case 'adminBookingsSummaryResponse':
            case 'adminAvailabilityResponse':
            case 'adminAvailabilityWeeklyResponse':
            case 'adminAvailabilityExceptionResponse':
                self::assertIsArray($body);
                $schema = match ($expected['body']) {
                    'publicBookableServicesResponse' => 'public-bookable-services-response.schema.json',
                    'bookingAvailabilityResponse' => 'booking-availability-response.schema.json',
                    'publicBookingResponse' => 'public-booking-response.schema.json',
                    'adminBookingsResponse' => 'admin-bookings-response.schema.json',
                    'adminBookingResponse' => 'admin-booking-response.schema.json',
                    'adminBookingsSummaryResponse' => 'admin-bookings-summary-response.schema.json',
                    'adminAvailabilityResponse' => 'admin-availability-response.schema.json',
                    'adminAvailabilityWeeklyResponse' => 'admin-availability-weekly-response.schema.json',
                    'adminAvailabilityExceptionResponse' =>
                        'admin-availability-exception-response.schema.json',
                    default => throw new \LogicException('Unknown booking response matcher.'),
                };
                self::assertSame([], $structural->validate($body, $schema));
                self::assertSame('no-store', $response->header('Cache-Control'));
                if ($expected['body'] === 'publicBookingResponse') {
                    foreach (['customerName', 'customerEmail', 'customerPhone', 'customerNote'] as $field) {
                        self::assertStringNotContainsString($field, $response->body);
                    }
                }
                if ($expected['body'] === 'adminBookingsSummaryResponse') {
                    // `summary.cancelledNeverInflatesConfirmed`, at the transport
                    // boundary: the listed entries are exactly the confirmed ones
                    // the counts claim, so a cancelled booking cannot be listed
                    // without the count disagreeing with the list.
                    self::assertIsArray($body['today']);
                    self::assertIsArray($body['upcoming']);
                    self::assertIsArray($body['counts']);
                    self::assertCount((int) $body['counts']['todayConfirmed'], $body['today']);
                    self::assertCount((int) $body['counts']['upcomingConfirmed'], $body['upcoming']);
                }
                break;

            case 'authSessionResponse':
                self::assertIsArray($body);
                self::assertSame(
                    [],
                    $structural->validate($body, 'auth-session-response.schema.json'),
                );
                self::assertSame($expected['authenticated'], $body['authenticated']);
                self::assertSame(
                    $expected['authenticated'],
                    $body['account'] !== null,
                    '`account` must be present exactly when authenticated',
                );

                // `auth.responsesNeverEchoSecrets`. The schema is strict, so it
                // already rejects an unexpected key; this catches the worse
                // mistake of putting a secret in a key that *is* declared.
                self::assertStringNotContainsString('passwordHash', $response->body);
                self::assertStringNotContainsString('$2y$', $response->body);
                self::assertStringNotContainsString('$argon2', $response->body);
                foreach ($this->sessionStore->sessions as $seeded) {
                    self::assertStringNotContainsString($seeded->id, $response->body);
                }
                break;

            default:
                self::fail("Unknown body matcher: {$expected['body']}");
        }
    }

    /**
     * Asserts an injected public page.
     *
     * The response is an HTML document, so there is no schema to validate it
     * against; what the contract actually promises is narrower and checkable:
     * which document reached the page, that the untouched parts of the export
     * survived, and that nothing about the injection can break the markup.
     *
     * @param array<mixed> $case
     * @param array<string, mixed> $expected
     */
    private function assertPublicPage(array $case, array $expected, Response $response): void
    {
        $artifacts = TestEnvironment::artifacts();
        $html = $response->body;

        // The export is passed through, not re-rendered. If PHP ever starts
        // templating the page these go first, which is the intent.
        self::assertStringContainsString('<!DOCTYPE html>', $html);
        self::assertStringContainsString(self::BAKED_MARKER, $html, 'baked body copy was lost');
        self::assertStringContainsString('<!-- PAGE-TAIL-MARKER -->', $html, 'the tail of the export was swallowed');
        self::assertStringContainsString('window.__DECOY__=1', $html, 'an unrelated script was overwritten');

        $payload = $this->bootstrapPayload($html);
        $decoded = json_decode($payload, true);

        self::assertIsArray($decoded, 'the injected payload is not parseable JSON');

        /** @var mixed $pageContent */
        $pageContent = $expected['pageContent'] ?? null;

        if ($pageContent === 'published') {
            /** @var int $revision */
            $revision = $case['publishedRevision'];
            self::assertSame($revision, $decoded['revision'], 'the published revision was not injected');
            self::assertNotNull($decoded['publishedAt']);
            self::assertSame(
                [],
                (new StructuralValidator($artifacts))->validate(
                    $decoded,
                    'published-content-envelope.output.schema.json',
                ),
            );
        }

        if ($pageContent === 'defaults') {
            // `publicPageFallbackOutcome`: the file goes out exactly as the build
            // left it. Not "some defaults" — the bytes the export baked in.
            self::assertSame(0, $decoded['revision']);
            self::assertNull($decoded['publishedAt']);
            self::assertNull($response->header('ETag'));
        }

        // `page.injectionCannotBreakOutOfTheScript`, checked on the wire rather
        // than on the encoder: whatever route the payload took to get here, it may
        // not contain a character that could close the element.
        foreach (['<', '>', '&'] as $character) {
            self::assertStringNotContainsString(
                $character,
                $payload,
                "raw {$character} reached the bootstrap payload",
            );
        }

        // `page.appearanceIsColoursOnly`.
        self::assertMatchesRegularExpression(
            '#^:root\{(--site-[a-z-]+:\#[0-9A-F]{6};)*--site-[a-z-]+:\#[0-9A-F]{6}\}$#',
            $this->appearanceBlock($html),
        );
    }

    private function bootstrapPayload(string $html): string
    {
        self::assertSame(
            1,
            preg_match(
                '#<script\b[^>]*\bid="__ESZTER_CONTENT__"[^>]*>(.*?)</script>#s',
                $html,
                $matches,
            ),
            'the served page carries no content bootstrap element',
        );

        return $matches[1];
    }

    private function appearanceBlock(string $html): string
    {
        self::assertSame(
            1,
            preg_match(
                '#<style\b[^>]*\bid="__ESZTER_APPEARANCE__"[^>]*>(.*?)</style>#s',
                $html,
                $matches,
            ),
            'the served page carries no appearance bootstrap element',
        );

        return $matches[1];
    }
}
