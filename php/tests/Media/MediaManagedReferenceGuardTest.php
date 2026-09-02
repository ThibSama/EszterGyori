<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Http\Request;
use Eszter\Kernel;
use Eszter\Media\DanglingMediaReferenceException;
use Eszter\Media\ManagedMediaReferenceGuard;
use Eszter\Media\MediaContract;
use Eszter\Media\UploadedFile;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-147 — the managed-reference guard itself.
 *
 * The guard is the runtime half of the invariant: among the `src` values a
 * content document carries, only the *managed* ones — those matching the
 * frozen `media.publicPathPattern`, read through {@see MediaContract} — are
 * checked, and each must exactly equal a public path the
 * {@see \Eszter\Media\MediaLibrary} catalogue carries. Everything outside the
 * managed namespace (HTTP(S), other public paths, null) is untouched, and
 * membership is decided by the catalogue alone, never by probing the
 * filesystem.
 */
final class MediaManagedReferenceGuardTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;
    private FakeUploadTransport $transport;
    private InMemorySessionStore $sessionStore;
    private InMemoryAccountDirectory $accounts;
    private string $sessionId;
    private string $csrfToken;
    private Kernel $kernel;
    private ManagedMediaReferenceGuard $guard;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-ref-guard');
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

        $this->guard = new ManagedMediaReferenceGuard(
            MediaContract::fromArtifacts(TestEnvironment::artifacts()),
            $this->kernel->mediaLibrary,
        );
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    // ── The decisions ──────────────────────────────────────────────────────

    public function testAManagedSrcAbsentFromTheCatalogueIsRefused(): void
    {
        $this->uploadAsset();

        $unknown = '/media/med_' . str_repeat('a', 32) . '.jpg';

        try {
            $this->guard->assertResolvable($this->contentPointingAt($unknown));
            self::fail('a managed src absent from the catalogue was accepted');
        } catch (DanglingMediaReferenceException $dangling) {
            self::assertSame([$unknown], $dangling->missingPaths);
            self::assertStringContainsString($unknown, $dangling->getMessage());
        }
    }

    public function testAnExactCataloguedPublicPathIsAccepted(): void
    {
        $asset = $this->uploadAsset();
        $path = (string) $asset['path'];

        // The guard accepts the exact catalogued path (a refusal would throw),
        // and the catalogue membership it relied on is unchanged afterwards.
        $this->guard->assertResolvable($this->contentPointingAt($path));
        self::assertSame([], $this->kernel->mediaLibrary->missingCataloguedPaths([$path]));
    }

    public function testAValidIdUnderTheWrongExtensionOrPathIsRefused(): void
    {
        $asset = $this->uploadAsset();

        // Same id, wrong extension: the catalogue carries <id>.jpg, not <id>.png.
        $wrongExtension = str_replace('.jpg', '.png', (string) $asset['path']);

        try {
            $this->guard->assertResolvable($this->contentPointingAt($wrongExtension));
            self::fail('a catalogued id under the wrong extension was accepted');
        } catch (DanglingMediaReferenceException $dangling) {
            self::assertSame([$wrongExtension], $dangling->missingPaths);
        }

        // Same extension, wrong id spelling: valid-looking, catalogued nowhere.
        $unknownId = '/media/med_' . str_repeat('b', 32) . '.jpg';

        try {
            $this->guard->assertResolvable($this->contentPointingAt($unknownId));
            self::fail('an uncatalogued managed path was accepted');
        } catch (DanglingMediaReferenceException $dangling) {
            self::assertSame([$unknownId], $dangling->missingPaths);
        }

        // The catalogued path itself still passes alongside the refusals above.
        $this->guard->assertResolvable($this->contentPointingAt((string) $asset['path']));
        self::assertNotSame($wrongExtension, $asset['path']);
    }

    public function testHttpStaticAndNullSrcsRemainValid(): void
    {
        $asset = $this->uploadAsset();

        $srcs = [
            'https://cdn.example.net/photo.jpg',
            'http://cdn.example.net/photo.png',
            '/assets/static/photo.webp',
            '/media/not-managed.jpg',
        ];

        foreach ($srcs as $src) {
            // No exception is the assertion for the non-managed value alone.
            $this->guard->assertResolvable($this->contentPointingAt($src));
        }

        // Null (the canonical state) passes.
        $this->guard->assertResolvable($this->contentPointingAt(null));

        // And a document mixing a catalogued managed src with HTTP(S), a
        // static path and a null src passes whole.
        $content = $this->contentPointingAt((string) $asset['path']);
        /** @var array<string, mixed> $about */
        $about = $content['about'];
        /** @var array<string, mixed> $portrait */
        $portrait = $about['portrait'];
        $portrait['src'] = 'https://cdn.example.net/eszter.jpg';
        $about['portrait'] = $portrait;
        $content['about'] = $about;
        $this->guard->assertResolvable($content);
    }

    public function testSeveralManagedRefsNameOnlyTheMissingOnes(): void
    {
        $first = $this->uploadAsset();
        $second = $this->uploadAsset();
        $missing = '/media/med_' . str_repeat('c', 32) . '.webp';

        $content = $this->contentPointingAt((string) $first['path']);
        /** @var array<string, mixed> $about */
        $about = $content['about'];
        /** @var array<string, mixed> $portrait */
        $portrait = $about['portrait'];
        $portrait['src'] = (string) $second['path'];
        $about['portrait'] = $portrait;
        $content['about'] = $about;
        /** @var array<string, mixed> $gallery */
        $gallery = $content['gallery'];
        /** @var list<array<string, mixed>> $items */
        $items = $gallery['items'];
        /** @var array<string, mixed> $firstItem */
        $firstItem = $items[0];
        /** @var array<string, mixed> $visual */
        $visual = $firstItem['visual'];
        $visual['src'] = $missing;
        $firstItem['visual'] = $visual;
        $items[0] = $firstItem;
        $gallery['items'] = $items;
        $content['gallery'] = $gallery;

        try {
            $this->guard->assertResolvable($content);
            self::fail('a document with one missing managed src was accepted');
        } catch (DanglingMediaReferenceException $dangling) {
            self::assertSame([$missing], $dangling->missingPaths);
        }
    }

    public function testAnEmptyCatalogueRefusesEveryManagedPath(): void
    {
        $path = '/media/med_' . str_repeat('d', 32) . '.jpg';

        $this->expectException(DanglingMediaReferenceException::class);
        $this->guard->assertResolvable($this->contentPointingAt($path));
    }

    // ── The catalogue is the authority, never the filesystem ───────────────

    public function testMembershipSurvivesDisagreementWithTheFilesystem(): void
    {
        $asset = $this->uploadAsset();
        $path = (string) $asset['path'];
        $fileName = basename($path);
        $publicFile = $this->publicMedia() . '/' . $fileName;

        // Entry present, bytes gone: the catalogue still names what the record
        // says exists, so the reference resolves. Nothing probed the filesystem.
        unlink($publicFile);
        self::assertFileDoesNotExist($publicFile);
        $this->guard->assertResolvable($this->contentPointingAt($path));

        // Bytes present, entry gone: the same file name is not part of the
        // library any more, so the reference is refused.
        $this->kernel->mediaLibrary->deleteAsset((string) $asset['id'], static fn (string $ignored): bool => false);
        file_put_contents($publicFile, 'stray bytes');
        self::assertFileExists($publicFile);

        try {
            $this->guard->assertResolvable($this->contentPointingAt($path));
            self::fail('a stray file under a managed name was treated as catalogued');
        } catch (DanglingMediaReferenceException $dangling) {
            self::assertSame([$path], $dangling->missingPaths);
        }
    }

    // ── Fixture ────────────────────────────────────────────────────────────

    /**
     * The canonical document with the hero visual's src replaced.
     *
     * @return array<string, mixed>
     */
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

    /** @return array<string, string> */
    private function authHeaders(): array
    {
        return [
            'cookie' => '__Host-eszter_session=' . $this->sessionId,
            'x-csrf-token' => $this->csrfToken,
        ];
    }

    private function publicMedia(): string
    {
        return $this->root . '/public_html/media';
    }
}
