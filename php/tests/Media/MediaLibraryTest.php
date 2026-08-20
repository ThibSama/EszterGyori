<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Media\MediaLibrary;
use Eszter\Media\MediaReferences;
use Eszter\Media\UploadedFile;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * Listing and deleting, and the rule that makes deleting safe (ESZ-037).
 *
 * Driven through the front controller for the same reason
 * {@see MediaUploadTest} is: the properties worth asserting — that a refusal
 * removed nothing, that a delete moved no content revision, that neither
 * response is cacheable — are properties of the route rather than of a class.
 */
final class MediaLibraryTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;
    private FakeUploadTransport $transport;
    private InMemorySessionStore $sessionStore;
    private InMemoryAccountDirectory $accounts;
    private string $sessionId;
    private string $csrfToken;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-media-library');
        $this->transport = new FakeUploadTransport();
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    // ── Listing ─────────────────────────────────────────────────────────────

    public function testAnEmptyLibraryListsNothingAndWritesNothing(): void
    {
        $kernel = $this->boot();

        $response = $kernel->handle($this->get());

        self::assertSame(200, $response->status);
        self::assertSame(['assets' => []], $response->decodedBody());

        // A read that seeded a catalogue would mean opening the media panel left
        // a file behind on a deployment that has never uploaded anything.
        self::assertFileDoesNotExist($this->indexPath());
    }

    public function testTheListIsNewestFirstAndStable(): void
    {
        $kernel = $this->boot();

        // Same frozen clock for all three, so `uploadedAt` cannot separate them
        // and the id tie-break is what has to make the order total. That is the
        // case a "sort by timestamp" implementation gets wrong: it would return
        // whatever order the catalogue happened to hold, differently per read.
        $ids = [];
        for ($index = 0; $index < 3; ++$index) {
            $ids[] = (string) $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()))['id'];
        }

        $first = $this->idsOf($kernel->handle($this->get()));
        $second = $this->idsOf($kernel->handle($this->get()));

        self::assertSame($first, $second, 'two reads returned different orders');
        self::assertSame(3, \count($first));
        self::assertSame([], array_diff($ids, $first));

        $sorted = $first;
        rsort($sorted);
        self::assertSame($sorted, $first, 'the tie-break is not the id, descending');
    }

    public function testListingReadsNoContentAtAll(): void
    {
        // The library records what exists; the content document records what is
        // used. A list that consulted content would make an unreadable draft look
        // like a broken media library.
        $kernel = $this->boot();

        self::assertSame(200, $kernel->handle($this->get())->status);

        self::assertFileDoesNotExist($this->root . '/data/content/draft.json');
        self::assertFileDoesNotExist($this->root . '/data/content/published.json');
    }

    public function testTheListDescribesTheStoredDerivative(): void
    {
        $kernel = $this->boot();
        $uploaded = $this->assetFrom($this->upload($kernel, MediaFixtures::png()));

        $listed = $kernel->handle($this->get())->decodedBody();

        self::assertIsArray($listed);
        self::assertSame([$uploaded], $listed['assets']);

        // And the metadata matches the file on disk, not the upload.
        $path = $this->publicMedia() . '/' . basename((string) $uploaded['path']);
        self::assertSame(filesize($path), $uploaded['byteSize']);
    }

    // ── Deleting ────────────────────────────────────────────────────────────

    public function testAnUnreferencedAssetDeletesCompletely(): void
    {
        $kernel = $this->boot();
        $kernel->storage->initialize();
        $asset = $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()));
        $fileName = basename((string) $asset['path']);

        $before = $this->storedContent();
        $response = $kernel->handle($this->delete((string) $asset['id']));

        self::assertSame(204, $response->status);
        self::assertSame('', $response->body);
        self::assertSame('no-store', $response->header('Cache-Control'));

        self::assertFileDoesNotExist($this->publicMedia() . '/' . $fileName);
        self::assertFileDoesNotExist($this->originals() . '/' . $fileName);
        self::assertSame(['assets' => []], $kernel->handle($this->get())->decodedBody());

        // `media.deleteRefusesWhileReferenced` also promises the converse: a
        // media operation never moves a content revision.
        self::assertSame($before, $this->storedContent());
        self::assertNull($response->header('x-content-revision'));
    }

    public function testADraftReferenceRefusesTheDelete(): void
    {
        $kernel = $this->boot();
        $kernel->storage->initialize();
        $asset = $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()));

        $this->pointDraftAt($kernel, (string) $asset['path']);
        $before = $this->storedContent();

        $response = $kernel->handle($this->delete((string) $asset['id']));

        self::assertSame(409, $response->status);
        self::assertSame('MEDIA_REFERENCED', $this->errorCodeOf($response));

        // Refusing removes nothing: not the file, not the original, not the entry.
        $fileName = basename((string) $asset['path']);
        self::assertFileExists($this->publicMedia() . '/' . $fileName);
        self::assertFileExists($this->originals() . '/' . $fileName);
        self::assertSame([$asset], $this->assetsOf($kernel->handle($this->get())));
        self::assertSame($before, $this->storedContent());
    }

    public function testAPublishedReferenceRefusesTheDeleteEvenWhenTheDraftHasMovedOn(): void
    {
        // The case that makes "both documents" load-bearing rather than
        // belt-and-braces. The editor removed the image from the draft; it is
        // still on the live site, and deleting it would break the public page for
        // every visitor while the CMS showed nothing wrong.
        $kernel = $this->boot();
        $asset = $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()));

        $this->pointDraftAt($kernel, (string) $asset['path']);
        $this->publishDraft($kernel);
        // Back to the canonical placeholder: the draft no longer uses the asset.
        $this->pointDraftAt($kernel, null);

        $draft = $kernel->storage->readDraft();
        $published = $kernel->storage->readPublished();

        self::assertNotContains(
            $asset['path'],
            MediaReferences::sourcesIn((array) $draft['content']),
            'the draft still references the asset, so this is not the case under test',
        );
        self::assertContains(
            $asset['path'],
            MediaReferences::sourcesIn((array) $published['content']),
        );

        $response = $kernel->handle($this->delete((string) $asset['id']));

        self::assertSame(409, $response->status);
        self::assertSame('MEDIA_REFERENCED', $this->errorCodeOf($response));
        self::assertFileExists($this->publicMedia() . '/' . basename((string) $asset['path']));
    }

    public function testRepointingAFieldDoesNotDeleteTheOldAsset(): void
    {
        // `media.contentEditsNeverDeleteAssets`. Reference-counting on save is
        // how one mistaken edit becomes unrecoverable, and it is exactly wrong
        // for a CMS where the same photograph is pointed at, unpointed and
        // pointed at again while a page is arranged.
        $kernel = $this->boot();
        $first = $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()));
        $second = $this->assetFrom($this->upload($kernel, MediaFixtures::png()));

        $this->pointDraftAt($kernel, (string) $first['path']);
        $this->pointDraftAt($kernel, (string) $second['path']);

        self::assertFileExists($this->publicMedia() . '/' . basename((string) $first['path']));
        self::assertCount(2, $this->assetsOf($kernel->handle($this->get())));

        // And now that nothing points at it, it can be removed deliberately.
        self::assertSame(204, $kernel->handle($this->delete((string) $first['id']))->status);
    }

    public function testAnUnknownIdIsANotFoundAndAMalformedOneIsAValidationFailure(): void
    {
        $kernel = $this->boot();

        $unknown = $kernel->handle($this->delete('med_' . str_repeat('a', 32)));
        self::assertSame(404, $unknown->status);
        self::assertSame('NOT_FOUND', $this->errorCodeOf($unknown));
        self::assertSame('no-store', $unknown->header('Cache-Control'));

        foreach (['', 'nope', '../../etc/passwd', 'med_' . str_repeat('z', 32)] as $malformed) {
            $response = $kernel->handle($this->delete($malformed));

            self::assertSame(400, $response->status, $malformed);
            self::assertSame('VALIDATION_FAILED', $this->errorCodeOf($response), $malformed);
        }
    }

    public function testATraversalIdNeverReachesAFilesystemCall(): void
    {
        // The schema pattern is what stops it, and this is the proof that nothing
        // downstream is relying on a sanitiser: a sibling file the id would name
        // if it were ever joined onto a directory is untouched.
        $kernel = $this->boot();
        $asset = $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()));
        $fileName = basename((string) $asset['path']);

        $victim = $this->root . '/data/content/draft.json';
        $kernel->storage->initialize();
        self::assertFileExists($victim);

        foreach (
            [
                '../../data/content/draft',
                './' . substr($fileName, 0, -4),
                'med_' . str_repeat('a', 32) . '/../' . substr($fileName, 0, -4),
            ] as $attempt
        ) {
            self::assertSame(400, $kernel->handle($this->delete($attempt))->status, $attempt);
        }

        self::assertFileExists($victim);
        self::assertFileExists($this->publicMedia() . '/' . $fileName);
    }

    public function testACatalogueEntryWhoseFileIsGoneStillDeletes(): void
    {
        // A disagreement between disk and catalogue must be resolvable. Refusing
        // because the file is missing would make the entry permanently
        // undeletable and the library permanently wrong.
        $kernel = $this->boot();
        $asset = $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()));
        $fileName = basename((string) $asset['path']);

        unlink($this->publicMedia() . '/' . $fileName);

        self::assertSame(204, $kernel->handle($this->delete((string) $asset['id']))->status);
        self::assertSame([], $this->assetsOf($kernel->handle($this->get())));
        self::assertFileDoesNotExist($this->originals() . '/' . $fileName);
    }

    public function testAFileWithNoCatalogueEntryIsNotDeletableThroughThisApi(): void
    {
        // The catalogue is authoritative for what the library contains. Bytes
        // nobody catalogued are not part of it, cannot be referenced — no id for
        // them was ever handed out — and are never removed by this route.
        $kernel = $this->boot();
        $stray = $this->publicMedia() . '/med_' . str_repeat('b', 32) . '.jpg';

        if (!is_dir($this->publicMedia())) {
            mkdir($this->publicMedia(), 0o770, true);
        }
        file_put_contents($stray, MediaFixtures::jpeg());

        $response = $kernel->handle($this->delete('med_' . str_repeat('b', 32)));

        self::assertSame(404, $response->status);
        self::assertFileExists($stray);
    }

    public function testAnUnreadableDraftStopsADeleteRatherThanAllowingIt(): void
    {
        // "The draft is unreadable" and "the draft does not use this image" are
        // different facts, and only one of them makes a delete safe. Treating the
        // first as the second is how a storage fault turns into data loss.
        $kernel = $this->boot();
        $asset = $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()));

        $kernel->storage->initialize();
        file_put_contents($this->root . '/data/content/draft.json', '{ not json');

        $response = $kernel->handle($this->delete((string) $asset['id']));

        self::assertSame(500, $response->status);
        self::assertSame('STORAGE_FAILURE', $this->errorCodeOf($response));
        self::assertFileExists($this->publicMedia() . '/' . basename((string) $asset['path']));
        self::assertStringNotContainsString($this->root, $response->body);
    }

    public function testACorruptCatalogueIsNeverSilentlyReplaced(): void
    {
        // The same fail-fast rule `ContentStorage` follows. Rewriting a catalogue
        // the service cannot parse would destroy the record of which files exist,
        // and the recovery — restoring a backup — needs the broken file to still
        // be there.
        $kernel = $this->boot();
        $this->upload($kernel, MediaFixtures::jpeg());

        file_put_contents($this->indexPath(), '{"schemaVersion": "one"}');

        $response = $kernel->handle($this->get());

        self::assertSame(500, $response->status);
        self::assertSame('STORAGE_FAILURE', $this->errorCodeOf($response));
        self::assertSame('{"schemaVersion": "one"}', file_get_contents($this->indexPath()));
    }

    // ── The reference scan itself ───────────────────────────────────────────

    public function testTheReferenceScanFindsEveryMediaSlotInTheRealDocument(): void
    {
        // The scan is the whole of "is this asset in use", so it is asserted
        // against the real document rather than a fixture: an asset used in a
        // section the walk cannot reach would be deletable while the site
        // displayed it.
        //
        // The canonical document ships every `src` as null — the placeholders
        // are drawn by CSS, not by files — so a scan of it as-published finds
        // nothing and would prove nothing. Every slot is therefore filled with a
        // distinguishable path first, which is also exactly what an editor
        // eventually does.
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        $expected = [];
        $filled = self::fillMediaSources($content, $expected);

        self::assertGreaterThan(0, \count($expected), 'the canonical document declares no media slots');

        $sources = MediaReferences::sourcesIn($filled);
        sort($sources);
        sort($expected);

        self::assertSame($expected, $sources);

        foreach ($expected as $source) {
            self::assertTrue(MediaReferences::isReferenced($filled, $source), $source);
        }

        self::assertFalse(
            MediaReferences::isReferenced($filled, '/media/med_' . str_repeat('c', 32) . '.jpg'),
        );

        // Null sources are not references. An empty slot must not protect an
        // asset, and must not be reported as one either.
        self::assertSame([], MediaReferences::sourcesIn($content));
    }

    public function testTheScanDeduplicatesRepeatedSources(): void
    {
        $repeated = [
            'a' => ['src' => '/media/same.jpg'],
            'b' => ['src' => '/media/same.jpg'],
            'c' => ['src' => '/media/other.jpg'],
        ];

        $sources = MediaReferences::sourcesIn($repeated);
        sort($sources);

        self::assertSame(['/media/other.jpg', '/media/same.jpg'], $sources);
    }

    /**
     * Puts a unique path in every `src` slot and records what it put there.
     *
     * @param array<mixed> $node
     * @param list<string> $assigned
     * @param-out list<string> $assigned
     * @return array<mixed>
     */
    private static function fillMediaSources(array $node, array &$assigned): array
    {
        foreach ($node as $key => $value) {
            if ($key === 'src' && ($value === null || \is_string($value))) {
                $path = '/media/med_' . str_pad(
                    (string) \count($assigned),
                    32,
                    '0',
                    \STR_PAD_LEFT,
                ) . '.jpg';
                $assigned[] = $path;
                $node[$key] = $path;

                continue;
            }

            if (\is_array($value)) {
                $node[$key] = self::fillMediaSources($value, $assigned);
            }
        }

        return $node;
    }

    public function testTheScanReachesArbitrarilyNestedSources(): void
    {
        $nested = ['a' => ['b' => [['c' => ['src' => '/media/deep.jpg']]]]];

        self::assertTrue(MediaReferences::isReferenced($nested, '/media/deep.jpg'));
        // A key that is not `src` is not a reference, however path-like its value.
        self::assertFalse(
            MediaReferences::isReferenced(['alt' => '/media/deep.jpg'], '/media/deep.jpg'),
        );
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private function boot(): Kernel
    {
        $configPath = TestEnvironment::writeDeployment($this->root);
        TestEnvironment::writeExportedPage($this->root);

        $clock = new FrozenClock(self::NOW);
        $this->accounts = InMemoryAccountDirectory::withAccount(true);
        $this->sessionStore = new InMemorySessionStore($clock);

        $account = $this->accounts->findByEmail(InMemoryAccountDirectory::EMAIL);
        self::assertNotNull($account);

        $session = $this->sessionStore->seed($account->id, $clock);
        $this->sessionId = $session->id;
        $this->csrfToken = $session->csrfToken;

        return Kernel::boot(
            $configPath,
            $clock,
            null,
            null,
            $this->accounts,
            $this->sessionStore,
            $this->transport,
        );
    }

    /**
     * Rewrites the draft so the hero visual points at $path (or back at the
     * canonical placeholder when it is null).
     *
     * It goes through `PUT /api/admin/content/draft` rather than writing the file,
     * because that is the workflow the contract requires selecting media to use —
     * "never create another content authority" — and a test that wrote the file
     * directly would prove the delete guard works against a state the real editor
     * can never produce.
     */
    private function pointDraftAt(Kernel $kernel, ?string $path): void
    {
        $draft = $kernel->storage->readDraft();
        /** @var array<string, mixed> $content */
        $content = $draft['content'];
        /** @var array<string, mixed> $hero */
        $hero = $content['hero'];
        /** @var array<string, mixed> $visual */
        $visual = $hero['visual'];

        $visual['src'] = $path;
        $hero['visual'] = $visual;
        $content['hero'] = $hero;

        $response = $kernel->handle(new Request(
            'PUT',
            '/api/admin/content/draft',
            $this->authHeaders() + ['content-type' => 'application/json'],
            (string) json_encode([
                'expectedRevision' => $draft['revision'],
                'content' => $content,
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        ));

        self::assertSame(200, $response->status, (string) $response->body);
    }

    private function publishDraft(Kernel $kernel): void
    {
        $response = $kernel->handle(new Request(
            'POST',
            '/api/admin/content/publish',
            $this->authHeaders() + ['content-type' => 'application/json'],
            (string) json_encode(['expectedRevision' => $kernel->storage->draftRevision()]),
        ));

        self::assertSame(200, $response->status, (string) $response->body);
    }

    private function get(): Request
    {
        return new Request('GET', '/api/admin/media', $this->authHeaders());
    }

    private function delete(string $id): Request
    {
        return new Request(
            'DELETE',
            '/api/admin/media',
            $this->authHeaders() + ['content-type' => 'application/json'],
            (string) json_encode(['id' => $id]),
        );
    }

    /** @return array<string, string> */
    private function authHeaders(): array
    {
        return [
            'cookie' => '__Host-eszter_session=' . $this->sessionId,
            'x-csrf-token' => $this->csrfToken,
        ];
    }

    private function upload(Kernel $kernel, string $bytes): Response
    {
        $path = $this->transport->stage($this->root, $bytes);

        return $kernel->handle(new Request(
            'POST',
            '/api/admin/media',
            $this->authHeaders() + ['content-type' => 'multipart/form-data; boundary=x'],
            '',
            [new UploadedFile('file', $path, \strlen($bytes), \UPLOAD_ERR_OK, 'p.jpg', 'image/jpeg')],
        ));
    }

    /** @return array<string, mixed> */
    private function assetFrom(Response $response): array
    {
        self::assertSame(201, $response->status, (string) $response->body);
        $body = $response->decodedBody();

        self::assertIsArray($body);
        self::assertIsArray($body['asset']);

        /** @var array<string, mixed> */
        return $body['asset'];
    }

    /** @return list<array<string, mixed>> */
    private function assetsOf(Response $response): array
    {
        $body = $response->decodedBody();

        self::assertIsArray($body);
        self::assertIsArray($body['assets']);

        /** @var list<array<string, mixed>> */
        return $body['assets'];
    }

    /** @return list<string> */
    private function idsOf(Response $response): array
    {
        return array_map(
            static fn (array $asset): string => (string) $asset['id'],
            $this->assetsOf($response),
        );
    }

    private function errorCodeOf(Response $response): string
    {
        $body = $response->decodedBody();

        self::assertIsArray($body);

        return (string) $body['error']['code'];
    }

    /** @return array<string, string|false> */
    private function storedContent(): array
    {
        return [
            'draft' => @file_get_contents($this->root . '/data/content/draft.json'),
            'published' => @file_get_contents($this->root . '/data/content/published.json'),
        ];
    }

    private function indexPath(): string
    {
        return $this->root . '/data/content/' . MediaLibrary::INDEX_FILE;
    }

    private function publicMedia(): string
    {
        return $this->root . '/public_html/media';
    }

    private function originals(): string
    {
        return $this->root . '/data/media-originals';
    }
}
