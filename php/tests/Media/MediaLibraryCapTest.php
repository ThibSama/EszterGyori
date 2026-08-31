<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Kernel;
use Eszter\Media\MediaLibrary;
use Eszter\Media\UploadedFile;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-084 — the one storage cap a caller could reach, and the trap it used to be.
 *
 * ## What was wrong
 *
 * `media-library.json` grows by one entry per upload and no request bounds the
 * total, so its 1 MB cap is genuinely reachable — unlike the content cap, which
 * the 64 kB request limit keeps out of range. The cap was enforced only when the
 * catalogue was *read*, and every media operation reads it first, delete included.
 * So crossing it produced a state with no way back: the library 500'd, and the one
 * operation that could have made it smaller was among the ones that had stopped
 * working. Recovery meant editing JSON on the host by hand.
 *
 * ## What these tests prove
 *
 * That the cap is now enforced before the write, so the state above is
 * unreachable: the upload that would cross it is refused, and the catalogue on
 * disk is left exactly as it was — still listable, still deletable, with nothing
 * of the refused upload anywhere.
 *
 * The cap is lowered through a legitimately re-signed contract copy rather than by
 * uploading five thousand images. The behaviour under test is "what happens at the
 * boundary", and the boundary's numeric value is not part of it.
 */
final class MediaLibraryCapTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    /**
     * Sized between one catalogue entry and two.
     *
     * One asset serialises to 315 bytes and two to 587, so 400 admits the first
     * upload and refuses the second. The numbers come from the real encoder — the
     * catalogue is written by {@see \Eszter\Storage\AtomicJsonFile}, whose
     * two-space indent and trailing newline are part of the byte count the cap is
     * compared against.
     */
    private const CAP_BYTES = 400;

    private string $root;
    private string $contracts;
    private FakeUploadTransport $transport;
    private InMemorySessionStore $sessionStore;
    private InMemoryAccountDirectory $accounts;
    private string $sessionId;
    private string $csrfToken;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-media-cap');
        $this->contracts = TestEnvironment::makeTempDirectory('eszter-media-cap-contracts');
        $this->transport = new FakeUploadTransport();

        TestEnvironment::copyContractsWithHttpMutation(
            $this->contracts,
            static function (array $contract): array {
                /** @var array<string, mixed> $limits */
                $limits = $contract['storageLimits'];
                $limits['mediaLibraryIndexLimitBytes'] = self::CAP_BYTES;
                $contract['storageLimits'] = $limits;

                return $contract;
            },
        );
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
        TestEnvironment::removeDirectory($this->contracts);
    }

    public function testTheCapIsReadFromTheContract(): void
    {
        self::assertSame(self::CAP_BYTES, $this->boot()->mediaLibrary->maxIndexBytes());
    }

    /**
     * The whole point: the catalogue never crosses its cap, so the read guard is
     * never the thing a person meets.
     */
    public function testAnUploadThatWouldCrossTheCapIsRefusedWithoutStoringAnything(): void
    {
        $kernel = $this->boot();

        $first = $this->upload($kernel, MediaFixtures::jpeg());
        self::assertSame(201, $first->status, (string) $first->body);

        $catalogueBefore = (string) file_get_contents($this->indexPath());
        $publicBefore = $this->fileNames($this->publicMedia());
        $originalsBefore = $this->fileNames($this->originals());

        $refused = $this->upload($kernel, MediaFixtures::jpeg());

        self::assertSame(413, $refused->status, (string) $refused->body);
        self::assertSame('PAYLOAD_TOO_LARGE', $this->errorCode($refused));

        // Byte-identical, not merely "still valid". A refusal that rewrote the
        // catalogue would be a different way to break the file it protects.
        self::assertSame($catalogueBefore, (string) file_get_contents($this->indexPath()));
        self::assertSame($publicBefore, $this->fileNames($this->publicMedia()));
        self::assertSame($originalsBefore, $this->fileNames($this->originals()));

        // And nothing was left in intake or staging on the way out.
        self::assertSame([], $this->fileNames($this->originals() . '/.intake'));
    }

    /**
     * The property whose absence made the old behaviour a trap: after the
     * refusal, the library is still fully usable — including the operation that
     * makes room.
     */
    public function testAFullCatalogueIsStillListableAndDeletable(): void
    {
        $kernel = $this->boot();

        $stored = $this->upload($kernel, MediaFixtures::jpeg());
        self::assertSame(201, $stored->status);
        /** @var array{asset: array{id: string}} $body */
        $body = $stored->decodedBody();
        $id = $body['asset']['id'];

        self::assertSame(413, $this->upload($kernel, MediaFixtures::jpeg())->status);

        $listed = $kernel->handle(new Request('GET', '/api/admin/media', $this->authHeaders()));
        self::assertSame(200, $listed->status, (string) $listed->body);

        $deleted = $kernel->handle(new Request(
            'DELETE',
            '/api/admin/media',
            $this->authHeaders() + ['content-type' => 'application/json'],
            (string) json_encode(['id' => $id]),
        ));
        self::assertSame(204, $deleted->status, (string) $deleted->body);

        // Room was made, so the upload that was refused now succeeds. That is the
        // difference between a limit and a wedge.
        self::assertSame(201, $this->upload($kernel, MediaFixtures::jpeg())->status);
    }

    // --- fixture ------------------------------------------------------------

    private function boot(): Kernel
    {
        $configPath = TestEnvironment::writeDeployment(
            $this->root,
            ['paths' => ['contracts' => $this->contracts]],
        );
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

    /** @return array<string, string> */
    private function authHeaders(): array
    {
        return [
            'cookie' => '__Host-eszter_session=' . $this->sessionId,
            'x-csrf-token' => $this->csrfToken,
        ];
    }

    private function errorCode(Response $response): ?string
    {
        $body = $response->decodedBody();

        return \is_array($body['error'] ?? null) ? ($body['error']['code'] ?? null) : null;
    }

    /** @return list<string> */
    private function fileNames(string $directory): array
    {
        if (!is_dir($directory)) {
            return [];
        }

        $names = array_values(array_diff(scandir($directory) ?: [], ['.', '..']));
        sort($names);

        return $names;
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
