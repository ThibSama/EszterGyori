<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\Request;
use Eszter\Http\RequestId;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Storage\PublishedContentReader;
use Eszter\Support\FrozenClock;
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

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-conformance');
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

        $response = $this->bootFor($case)->handle(new Request(
            $request['method'],
            $request['path'],
            $request['headers'] ?? [],
            $request['rawBody'] ?? '',
        ));

        self::assertSame($expected['status'], $response->status, 'status');

        $this->assertHeaders($expected, $response);
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

        return $this->boot($this->reader(
            \is_string($storage) ? $storage : 'ok',
            \is_int($revision) ? $revision : 0,
        ));
    }

    private function boot(?PublishedContentReader $reader = null): Kernel
    {
        $configPath = TestEnvironment::writeDeployment($this->root);

        // `/` reads the exported page out of the document root, so a deployment
        // without one has no page to serve. Written per boot rather than once, so
        // a case that rewrites it cannot leak into the next.
        TestEnvironment::writeExportedPage($this->root, self::BAKED_MARKER);

        return Kernel::boot(
            $configPath,
            new FrozenClock(self::NOW),
            $reader ?? $this->reader('ok', 0),
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
