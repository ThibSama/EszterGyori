<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Media\DanglingMediaReferenceException;
use Eszter\Media\UploadedFile;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-147 — the invariant end to end: storage decisions, byte identity, and
 * the two frozen HTTP outcomes.
 *
 * The production kernel wires the managed-reference guard into every save and
 * publish, so everything here runs through the real route and the real locks.
 * Proofs:
 *
 *  1. an unknown managed path submitted to a save is refused with nothing
 *     written and nothing moved — draft bytes and revision identical;
 *  2. the exact catalogued path saves;
 *  3. a valid-looking id under the wrong extension or an uncatalogued path is
 *     refused;
 *  4. a deliberately prepared dangling stored draft cannot be published — the
 *     previous published bytes and revision survive byte-identical;
 *  5. HTTP(S), static/non-managed paths and null save without regression.
 *
 * The HTTP semantics are part of the proof too: the save refusal is the
 * caller's 400 VALIDATION_FAILED (checked under the shared boundary, so no
 * write crossed it), the publish refusal is the service's opaque 500
 * STORAGE_FAILURE that names no path, and no public error code was added.
 */
final class MediaReferenceIntegrityTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;
    private FakeUploadTransport $transport;
    private InMemorySessionStore $sessionStore;
    private InMemoryAccountDirectory $accounts;
    private string $sessionId;
    private string $csrfToken;
    private Kernel $kernel;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-ref-integrity');
        $configPath = TestEnvironment::writeDeployment($this->root);
        TestEnvironment::writeExportedPage($this->root);
        $this->transport = new FakeUploadTransport();

        $clock = new FrozenClock(self::NOW);
        $this->accounts = InMemoryAccountDirectory::withAccount(true);
        $this->sessionStore = new InMemorySessionStore($clock);

        $account = $this->accounts->findByEmail(InMemoryAccountDirectory::EMAIL);
        self::assertNotNull($account);
        $session = $this->sessionStore->seed($account->id, $clock);
        $this->sessionId = $session->id;
        $this->csrfToken = $session->csrfToken;

        $this->kernel = Kernel::boot(
            $configPath,
            $clock,
            null,
            null,
            $this->accounts,
            $this->sessionStore,
            $this->transport,
        );
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    // ── Proof 1: unknown managed path on save => refusal, nothing moved ────

    public function testSaveRefusesAnUnknownManagedPathAndLeavesTheDraftByteIdentical(): void
    {
        $this->uploadAsset();
        $this->initialize();
        $unknown = '/media/med_' . str_repeat('a', 32) . '.jpg';

        $draftBefore = $this->rawDraft();
        $publishedBefore = $this->rawPublished();

        try {
            $this->kernel->storage->saveDraft(0, $this->contentPointingAt($unknown));
            self::fail('a save carrying an unknown managed path was accepted');
        } catch (DanglingMediaReferenceException $dangling) {
            self::assertSame([$unknown], $dangling->missingPaths);
        }

        self::assertSame($draftBefore, $this->rawDraft(), 'the refusal rewrote the draft');
        self::assertSame($publishedBefore, $this->rawPublished(), 'the refusal touched published');
        self::assertSame([], $this->tmpResidue(), 'the refusal left a temp file behind');
        self::assertSame(0, $this->kernel->storage->draftRevision(), 'the refusal moved the revision');
    }

    // ── Proof 2: the exact catalogued path saves ───────────────────────────

    public function testSaveSucceedsForTheExactCataloguedPath(): void
    {
        $asset = $this->uploadAsset();
        $this->initialize();

        $response = $this->saveRequest((string) $asset['path']);

        self::assertSame(200, $response->status, (string) $response->body);
        $body = $response->decodedBody();
        self::assertIsArray($body);
        self::assertSame(1, $body['revision']);

        $draft = $this->kernel->storage->readDraft();
        self::assertSame(1, $draft['revision']);
        self::assertSame(
            (string) $asset['path'],
            $this->heroSrcOf((array) $draft['content']),
            'the saved draft does not carry the exact catalogued path',
        );
    }

    // ── Proof 3: valid id, wrong path or extension => refusal ──────────────

    public function testSaveRefusesACataloguedIdUnderTheWrongExtension(): void
    {
        $asset = $this->uploadAsset();
        $this->initialize();
        $wrongExtension = str_replace('.jpg', '.png', (string) $asset['path']);
        $draftBefore = $this->rawDraft();

        $response = $this->saveRequest($wrongExtension);

        self::assertSame(400, $response->status, (string) $response->body);
        self::assertSame('VALIDATION_FAILED', $this->errorCodeOf($response));
        self::assertSame($draftBefore, $this->rawDraft(), 'the refused save rewrote the draft');
        self::assertSame(0, $this->kernel->storage->draftRevision());
    }

    public function testSaveRefusesAValidLookingUncataloguedManagedPath(): void
    {
        $this->uploadAsset();
        $this->initialize();
        $uncatalogued = '/media/med_' . str_repeat('b', 32) . '.webp';
        $draftBefore = $this->rawDraft();

        $response = $this->saveRequest($uncatalogued);

        self::assertSame(400, $response->status, (string) $response->body);
        self::assertSame('VALIDATION_FAILED', $this->errorCodeOf($response));
        self::assertSame($draftBefore, $this->rawDraft());
        self::assertSame([], $this->tmpResidue());
    }

    // ── Proof 4: a deliberately dangling stored draft cannot be published ──

    public function testPublishRefusesADanglingStoredDraftAndLeavesPublishedByteIdentical(): void
    {
        $this->uploadAsset();
        $this->initialize();
        $unknown = '/media/med_' . str_repeat('c', 32) . '.jpg';

        // The dangling draft is stored through the raw envelope writer — the
        // one content write that must not enforce anything — exactly like the
        // inconsistent state a restore or a legacy file could leave behind.
        $this->kernel->storage->writeDraft([
            'schemaVersion' => TestEnvironment::artifacts()->contentSchemaVersion(),
            'revision' => 1,
            'updatedAt' => self::NOW,
            'content' => $this->contentPointingAt($unknown),
        ]);
        $publishedBefore = $this->rawPublished();

        try {
            $this->kernel->storage->publishDraft(1);
            self::fail('a publish of a dangling stored draft was accepted');
        } catch (DanglingMediaReferenceException $dangling) {
            self::assertSame([$unknown], $dangling->missingPaths);
        }

        self::assertSame($publishedBefore, $this->rawPublished(), 'the refusal rewrote published');
        self::assertSame([], $this->tmpResidue());

        $published = json_decode($this->rawPublished(), true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($published);
        self::assertSame(0, $published['revision']);
        self::assertNotSame(
            $unknown,
            $this->heroSrcOf((array) $published['content']),
            'the dangling reference reached the published document',
        );
    }

    public function testPublishRefusalAnswersOpaque500StorageFailure(): void
    {
        $this->uploadAsset();
        $this->initialize();
        $unknown = '/media/med_' . str_repeat('d', 32) . '.jpg';

        $this->kernel->storage->writeDraft([
            'schemaVersion' => TestEnvironment::artifacts()->contentSchemaVersion(),
            'revision' => 1,
            'updatedAt' => self::NOW,
            'content' => $this->contentPointingAt($unknown),
        ]);
        $publishedBefore = $this->rawPublished();

        $response = $this->publishRequest(1);

        self::assertSame(500, $response->status);
        self::assertSame('STORAGE_FAILURE', $this->errorCodeOf($response));
        self::assertSame($publishedBefore, $this->rawPublished());

        // Opaque by contract: the body names no path and no managed id.
        $body = $response->decodedBody();
        self::assertIsArray($body);
        self::assertStringNotContainsString('/media/med_', (string) json_encode($body));
        self::assertStringNotContainsString('media', (string) json_encode($body['error'] ?? []));
    }

    // ── Proof 5: HTTP(S), static paths and null save without regression ────

    public function testHttpStaticAndNullSourcesStillSave(): void
    {
        $asset = $this->uploadAsset();
        $this->initialize();

        $srcs = [
            'https://cdn.example.net/photo.jpg',
            'http://cdn.example.net/photo.png',
            '/assets/static/photo.webp',
            null,
        ];

        foreach ($srcs as $index => $src) {
            $response = $this->saveRequest($src);
            self::assertSame(200, $response->status, (string) $response->body . " for src #{$index}");
        }

        // And a document mixing a catalogued managed src with an HTTPS one.
        $content = $this->contentPointingAt((string) $asset['path']);
        $response = $this->saveRequestWith($content);
        self::assertSame(200, $response->status, (string) $response->body);
        self::assertSame(5, $this->kernel->storage->draftRevision());
    }

    // ── Save refusal at the HTTP layer, once, whole ────────────────────────

    public function testSaveRefusalAnswers400ValidationFailed(): void
    {
        $this->uploadAsset();
        $this->initialize();
        $unknown = '/media/med_' . str_repeat('e', 32) . '.jpg';
        $draftBefore = $this->rawDraft();
        $publishedBefore = $this->rawPublished();

        $response = $this->saveRequest($unknown);

        self::assertSame(400, $response->status, (string) $response->body);
        self::assertSame('VALIDATION_FAILED', $this->errorCodeOf($response));
        self::assertArrayNotHasKey('x-content-revision', $response->headers);
        self::assertSame($draftBefore, $this->rawDraft());
        self::assertSame($publishedBefore, $this->rawPublished());
        self::assertSame(0, $this->kernel->storage->draftRevision());
    }

    // ── Fixture ────────────────────────────────────────────────────────────

    private function initialize(): void
    {
        $this->kernel->storage->initialize();
    }

    /** @return array<string, mixed> */
    private function contentPointingAt(?string $src): array
    {
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        /** @var array<string, mixed> $hero */
        $hero = $content['hero'];
        /** @var array<string, mixed> $visual */
        $visual = $hero['visual'];
        $visual['src'] = $src;
        $hero['visual'] = $visual;
        $content['hero'] = $hero;

        return $content;
    }

    /** @return array<string, mixed> */
    private function uploadAsset(): array
    {
        $path = $this->transport->stage($this->root, MediaFixtures::jpeg());
        $response = $this->kernel->handle(new Request(
            'POST',
            '/api/admin/media',
            $this->authHeaders() + ['content-type' => 'multipart/form-data; boundary=x'],
            '',
            [new UploadedFile('file', $path, \strlen(MediaFixtures::jpeg()), \UPLOAD_ERR_OK, 'p.jpg', 'image/jpeg')],
        ));

        self::assertSame(201, $response->status, (string) $response->body);
        $body = $response->decodedBody();
        self::assertIsArray($body);
        self::assertIsArray($body['asset']);

        /** @var array<string, mixed> */
        return $body['asset'];
    }

    private function saveRequest(?string $src): Response
    {
        return $this->saveRequestWith($this->contentPointingAt($src));
    }

    /** @param array<string, mixed> $content */
    private function saveRequestWith(array $content): Response
    {
        return $this->kernel->handle(new Request(
            'PUT',
            '/api/admin/content/draft',
            $this->authHeaders() + ['content-type' => 'application/json'],
            (string) json_encode([
                'expectedRevision' => $this->kernel->storage->draftRevision(),
                'content' => $content,
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        ));
    }

    private function publishRequest(int $expectedRevision): Response
    {
        return $this->kernel->handle(new Request(
            'POST',
            '/api/admin/content/publish',
            $this->authHeaders() + ['content-type' => 'application/json'],
            (string) json_encode(['expectedRevision' => $expectedRevision]),
        ));
    }

    /** @return array<string, string> */
    private function authHeaders(): array
    {
        return [
            'cookie' => '__Host-eszter_session=' . $this->sessionId,
            'x-csrf-token' => $this->csrfToken,
        ];
    }

    private function rawDraft(): string
    {
        return (string) file_get_contents($this->kernel->storage->draftPath());
    }

    private function rawPublished(): string
    {
        return (string) file_get_contents($this->kernel->storage->publishedPath());
    }

    /** @return list<string> */
    private function tmpResidue(): array
    {
        return glob($this->root . '/var/tmp/*') ?: [];
    }

    /**
     * @param array<string, mixed> $content
     */
    private function heroSrcOf(array $content): ?string
    {
        /** @var mixed $hero */
        $hero = $content['hero'] ?? null;
        /** @var mixed $visual */
        $visual = \is_array($hero) ? ($hero['visual'] ?? null) : null;
        /** @var mixed $src */
        $src = \is_array($visual) ? ($visual['src'] ?? null) : null;

        return \is_string($src) ? $src : null;
    }

    private function errorCodeOf(Response $response): ?string
    {
        $body = $response->decodedBody();
        self::assertIsArray($body);
        self::assertIsArray($body['error']);

        /** @var mixed $code */
        $code = $body['error']['code'] ?? null;

        return \is_string($code) ? $code : null;
    }
}
