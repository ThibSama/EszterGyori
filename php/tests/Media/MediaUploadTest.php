<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Media\MediaLibrary;
use Eszter\Media\UploadedFile;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The ingest pipeline, driven end to end through the front controller (ESZ-036).
 *
 * Everything here goes through `Kernel::handle()` rather than calling
 * {@see \Eszter\Media\MediaIngest} directly, because most of what is being
 * asserted is a property of the *route*: that a rejection produced no file under
 * the document root, that the response leaked no path, that the body limit
 * applied. A unit test of the ingest could assert none of those, and the ones it
 * could assert would be about a class rather than about the surface a caller
 * reaches.
 *
 * The contract corpus already replays the route's boundary — who may call it,
 * what a wrong method answers. This suite is the part that needs bytes, and the
 * contract says why it is here rather than in the artifact: a case would have to
 * carry a JPEG, a truncated JPEG and a PHP script renamed to `.jpg` as literals
 * in a file every implementation parses.
 *
 * Since ESZ-135 it also drives every standard PHP upload error code through the
 * route: the caller-side refusals (`UPLOAD_ERR_INI_SIZE`/`FORM_SIZE` → 413,
 * `UPLOAD_ERR_NO_FILE`/`PARTIAL` → 400) are unchanged, while the host faults
 * (`UPLOAD_ERR_NO_TMP_DIR`/`CANT_WRITE`/`EXTENSION`, and any unrecognised
 * non-zero code) answer the opaque generic 500, log at error level and leave
 * nothing behind.
 */
final class MediaUploadTest extends TestCase
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
        $this->root = TestEnvironment::makeTempDirectory('eszter-media');
        $this->transport = new FakeUploadTransport();
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    // ── The happy path, and what it stores ──────────────────────────────────

    /** @return iterable<string, array{string, string, string}> */
    public static function acceptedFormats(): iterable
    {
        yield 'jpeg' => [MediaFixtures::jpeg(), 'image/jpeg', 'jpg'];
        yield 'png' => [MediaFixtures::png(), 'image/png', 'png'];
        yield 'webp' => [MediaFixtures::webp(), 'image/webp', 'webp'];
    }

    #[DataProvider('acceptedFormats')]
    public function testEachAllowedFormatIsStoredUnderAServerGeneratedName(
        string $bytes,
        string $expectedType,
        string $expectedExtension,
    ): void {
        $kernel = $this->boot();

        // The filename and the declared type are both hostile and both must be
        // irrelevant. If either reached a decision, this upload would be refused
        // or stored under a name it chose.
        $response = $this->upload($kernel, $bytes, '../../evil.php', 'application/x-httpd-php');

        self::assertSame(201, $response->status);
        $asset = $this->assetFrom($response);

        self::assertSame($expectedType, $asset['mimeType']);
        self::assertMatchesRegularExpression('/^med_[0-9a-f]{32}$/', (string) $asset['id']);
        self::assertSame("/media/{$asset['id']}.{$expectedExtension}", $asset['path']);
        self::assertSame(self::NOW, $asset['uploadedAt']);
        self::assertGreaterThan(0, $asset['byteSize']);
        self::assertSame(64, $asset['width']);
        self::assertSame(48, $asset['height']);

        // The derivative is where the URL says and nowhere else, and the original
        // is outside the document root.
        self::assertFileExists($this->publicMedia() . "/{$asset['id']}.{$expectedExtension}");
        self::assertFileExists($this->originals() . "/{$asset['id']}.{$expectedExtension}");
        self::assertSame([], $this->strayNames($this->publicMedia()));

        // Not one byte of the client's filename reached the disk.
        foreach (scandir($this->publicMedia()) ?: [] as $entry) {
            self::assertStringNotContainsString('evil', $entry);
            self::assertStringNotContainsString('php', $entry);
        }
    }

    public function testTwoUploadsOfIdenticalBytesGetDifferentIds(): void
    {
        // `media.storedNamesAreServerGenerated`. A content hash would collide
        // here, and deleting one usage would then break the other.
        $kernel = $this->boot();
        $bytes = MediaFixtures::jpeg();

        $first = $this->assetFrom($this->upload($kernel, $bytes));
        $second = $this->assetFrom($this->upload($kernel, $bytes));

        self::assertNotSame($first['id'], $second['id']);
        self::assertNotSame($first['path'], $second['path']);
        self::assertFileExists($this->publicMedia() . '/' . basename((string) $first['path']));
        self::assertFileExists($this->publicMedia() . '/' . basename((string) $second['path']));
    }

    public function testStoredFilesCarryThePolicyModes(): void
    {
        // ESZ-103, through the real route: the private boundary (verified
        // original and authoritative catalogue at 0640, empty intake) and the
        // public boundary (served derivative at the intentional 0644).
        $kernel = $this->boot();
        $asset = $this->assetFrom($this->upload($kernel, MediaFixtures::jpeg()));
        $fileName = basename((string) $asset['path']);

        self::assertSame(0o640, fileperms($this->originals() . '/' . $fileName) & 0o777);
        self::assertSame(
            0o640,
            fileperms($this->root . '/data/content/' . MediaLibrary::INDEX_FILE) & 0o777,
        );
        self::assertSame([], $this->entriesOf($this->intake()));
        self::assertSame(0o644, fileperms($this->publicMedia() . '/' . $fileName) & 0o777);
    }

    public function testTheStoredBytesAreTheServersOwnEncoding(): void
    {
        // `media.storedBytesAreTheServersOwnEncoding`. Two probes, because they
        // fail differently: a marker inside an EXIF segment proves metadata is
        // gone, and a payload appended after EOI proves a polyglot's tail cannot
        // ride along inside a file the site then serves.
        $kernel = $this->boot();
        $marker = 'GPS-LATITUDE-47.4979-LONGITUDE-19.0402';

        $withExif = $this->assetFrom(
            $this->upload($kernel, MediaFixtures::jpegWithMetadata($marker)),
        );
        $served = (string) file_get_contents(
            $this->publicMedia() . '/' . basename((string) $withExif['path']),
        );

        self::assertStringNotContainsString($marker, $served);

        $payload = '<?php echo shell_exec($_GET["c"]); ?>';
        $withTail = $this->assetFrom(
            $this->upload($kernel, MediaFixtures::jpegWithAppendedPayload($payload)),
        );
        $servedTail = (string) file_get_contents(
            $this->publicMedia() . '/' . basename((string) $withTail['path']),
        );

        self::assertStringNotContainsString($payload, $servedTail);
        self::assertStringNotContainsString('<?php', $servedTail);
    }

    public function testUploadingChangesNoContent(): void
    {
        // `media.libraryIsTheOnlyRegistry`: uploading gathers an image, it does
        // not put one on the page. A save is a separate, explicit act.
        $kernel = $this->boot();
        $kernel->storage->initialize();
        $before = $this->storedContent();

        self::assertSame(201, $this->upload($kernel, MediaFixtures::jpeg())->status);
        self::assertSame($before, $this->storedContent());
    }

    public function testAMediaResponseCarriesNoRevisionHeaderAndIsNotCacheable(): void
    {
        $kernel = $this->boot();
        $response = $this->upload($kernel, MediaFixtures::jpeg());

        self::assertSame('no-store', $response->header('Cache-Control'));
        self::assertNull($response->header('x-content-revision'));
        self::assertNull($response->header('ETag'));
    }

    // ── Refusals: the bytes decide, and nothing else ────────────────────────

    /** @return iterable<string, array{string, string}> */
    public static function refusedContent(): iterable
    {
        yield 'a php script wearing jpeg magic bytes' => [
            MediaFixtures::phpScriptWithJpegMagic(),
            'photo.jpg',
        ];
        yield 'a php script, undisguised' => [MediaFixtures::phpScript(), 'photo.jpg'];
        yield 'an svg carrying a script' => [MediaFixtures::svgWithScript(), 'logo.svg'];
        yield 'a gif, which is off the allowlist' => [MediaFixtures::gif(), 'anim.gif'];
        yield 'a truncated jpeg' => [MediaFixtures::truncatedJpeg(), 'half.jpg'];
        yield 'bytes that are not an image' => [MediaFixtures::notAnImage(), 'notes.jpg'];
        yield 'an empty part' => ['', 'empty.jpg'];
    }

    #[DataProvider('refusedContent')]
    public function testUnacceptableBytesAreRefusedAndLeaveNothingBehind(
        string $bytes,
        string $fileName,
    ): void {
        $kernel = $this->boot();

        // Declared as an image by a caller who would very much like it accepted.
        $response = $this->upload($kernel, $bytes, $fileName, 'image/jpeg');

        self::assertSame(400, $response->status, $fileName);
        self::assertSame('VALIDATION_FAILED', $this->errorCodeOf($response));

        $this->assertNothingWasLeftBehind();
    }

    public function testAPolyglotWhoseTwoParsersDisagreeIsRefused(): void
    {
        // `finfo` reads magic bytes; `getimagesize()` parses the image header.
        // A file that answers them differently is two files at once, and the
        // ingest refuses rather than picking a winner. A GIF renamed and
        // declared as a JPEG is the cheapest way to produce the disagreement
        // *after* both parsers agree it is an image.
        $kernel = $this->boot();
        $response = $this->upload($kernel, MediaFixtures::gif(), 'photo.jpg', 'image/jpeg');

        self::assertSame(400, $response->status);
        $this->assertNothingWasLeftBehind();
    }

    public function testADeclaredTypeCannotRescueOrCondemnAFile(): void
    {
        // Both halves of `media.acceptanceIsDecidedByBytesAlone`, in one test:
        // a real JPEG with an absurd name and a nonsense declared type is
        // accepted, and the previous test showed the reverse is refused.
        $kernel = $this->boot();
        $response = $this->upload(
            $kernel,
            MediaFixtures::jpeg(),
            "..\\..\\..\\windows\\system32\\a.txt\x00.png",
            'application/octet-stream',
        );

        self::assertSame(201, $response->status);
        self::assertSame('image/jpeg', $this->assetFrom($response)['mimeType']);
    }

    public function testAnImageDeclaringEnormousDimensionsIsRefusedBeforeItIsDecoded(): void
    {
        // `media.dimensionsAreBoundedBeforeDecoding`. The file is a few hundred
        // bytes and its header claims ~1.6 × 10^10 pixels; decoding it would try
        // to allocate that, so the only safe outcome is a refusal that happens
        // first. The test passing at all is the assertion — a pipeline that
        // decoded first would exhaust memory here rather than return.
        $kernel = $this->boot();
        $bomb = MediaFixtures::pngDeclaringDimensions(128_000, 128_000);

        self::assertLessThan(4096, \strlen($bomb), 'the bomb fixture is not compressed');

        $response = $this->upload($kernel, $bomb, 'wide.png', 'image/png');

        self::assertSame(400, $response->status);
        $this->assertNothingWasLeftBehind();
    }

    public function testAFileOverTheRouteLimitIsRefusedWithoutBeingInspected(): void
    {
        $kernel = $this->boot();
        $limit = $kernel->media->uploadLimitBytes;

        // A real JPEG's header followed by enough padding to pass the limit, so
        // the file would type as an image if anything got as far as typing it.
        $oversized = MediaFixtures::jpeg() . str_repeat("\x00", $limit + 1);

        $response = $this->upload($kernel, $oversized, 'huge.jpg', 'image/jpeg');

        self::assertSame(413, $response->status);
        self::assertSame('PAYLOAD_TOO_LARGE', $this->errorCodeOf($response));
        $this->assertNothingWasLeftBehind();
    }

    public function testPhpsOwnSizeRefusalIsAlsoA413(): void
    {
        // UPLOAD_ERR_INI_SIZE: PHP decided before the script ran. The caller's
        // problem is identical — the file is too big — so the answer must be too,
        // or the same user action would produce two different messages.
        $kernel = $this->boot();

        $response = $kernel->handle($this->request('POST', [
            new UploadedFile('file', '/nonexistent', 9_000_000, \UPLOAD_ERR_INI_SIZE, 'big.jpg'),
        ]));

        self::assertSame(413, $response->status);
        self::assertSame('PAYLOAD_TOO_LARGE', $this->errorCodeOf($response));
    }

    // ── PHP upload error-code classification (ESZ-135) ─────────────────────

    /**
     * Every standard PHP upload error code, driven through the real route.
     *
     * ESZ-135 froze the classification: the codes PHP uses to say "I could not
     * take this upload" are three different kinds of failure and must not all be
     * reported as a caller validation failure. `UPLOAD_ERR_INI_SIZE` and
     * `UPLOAD_ERR_FORM_SIZE` mean the file was too big -> 413; `UPLOAD_ERR_NO_FILE`
     * and `UPLOAD_ERR_PARTIAL` mean the part carried nothing usable -> 400; and
     * `UPLOAD_ERR_NO_TMP_DIR`, `UPLOAD_ERR_CANT_WRITE` and `UPLOAD_ERR_EXTENSION`
     * are host faults -> the opaque generic 500. Any other non-zero code fails
     * closed the same way.
     *
     * The `bytes` row for `UPLOAD_ERR_OK` is a real image: proving 201 through
     * the same table keeps the success path honest rather than assumed.
     *
     * @return iterable<string, array{int, string|null, int, string|null}>
     */
    public static function phpUploadErrorCodes(): iterable
    {
        yield 'ok' => [\UPLOAD_ERR_OK, MediaFixtures::jpeg(), 201, null];
        yield 'ini_size' => [\UPLOAD_ERR_INI_SIZE, null, 413, 'PAYLOAD_TOO_LARGE'];
        yield 'form_size' => [\UPLOAD_ERR_FORM_SIZE, null, 413, 'PAYLOAD_TOO_LARGE'];
        yield 'no_file' => [\UPLOAD_ERR_NO_FILE, null, 400, 'VALIDATION_FAILED'];
        yield 'partial' => [\UPLOAD_ERR_PARTIAL, null, 400, 'VALIDATION_FAILED'];
        yield 'no_tmp_dir' => [\UPLOAD_ERR_NO_TMP_DIR, null, 500, 'INTERNAL_ERROR'];
        yield 'cant_write' => [\UPLOAD_ERR_CANT_WRITE, null, 500, 'INTERNAL_ERROR'];
        yield 'extension' => [\UPLOAD_ERR_EXTENSION, null, 500, 'INTERNAL_ERROR'];
        yield 'unassigned code 5' => [5, null, 500, 'INTERNAL_ERROR'];
        yield 'unknown code 99' => [99, null, 500, 'INTERNAL_ERROR'];
    }

    #[DataProvider('phpUploadErrorCodes')]
    public function testEachPhpUploadErrorCodeAnswersItsFrozenClass(
        int $errorCode,
        ?string $bytes,
        int $expectedStatus,
        ?string $expectedErrorCode,
    ): void {
        $kernel = $this->boot();

        $response = $bytes !== null
            ? $this->upload($kernel, $bytes)
            : $kernel->handle($this->request('POST', [
                // A path PHP would never have filled: every refusal below
                // happens before any transport access, so the path must never
                // be read, moved or named.
                new UploadedFile('file', '/nonexistent', 0, $errorCode, 'big.jpg', 'image/jpeg'),
            ]));

        self::assertSame($expectedStatus, $response->status, "error code {$errorCode}");

        if ($expectedErrorCode === null) {
            self::assertArrayHasKey('asset', $response->decodedBody());

            return;
        }

        self::assertSame($expectedErrorCode, $this->errorCodeOf($response));

        // Proof 6 of ESZ-135: every refusal leaves zero managed artefacts —
        // no intake file, no original, no derivative under /media/, no
        // catalogue entry. These checks run before any intake movement, so the
        // residue each could leave is exactly what this asserts.
        $this->assertNothingWasLeftBehind();
    }

    /**
     * Host upload faults answer the opaque 500 and log at error level, and
     * neither the PHP error number nor any path reaches either surface's copy
     * the wrong way (ESZ-135 proofs 4, 5 and 7).
     *
     * @return iterable<string, array{int}>
     */
    public static function hostFaultUploadCodes(): iterable
    {
        yield 'no_tmp_dir' => [\UPLOAD_ERR_NO_TMP_DIR];
        yield 'cant_write' => [\UPLOAD_ERR_CANT_WRITE];
        yield 'extension' => [\UPLOAD_ERR_EXTENSION];
        yield 'unknown' => [99];
    }

    #[DataProvider('hostFaultUploadCodes')]
    public function testHostFaultUploadsAreLoggedAtErrorLevelAndStayOpaque(int $errorCode): void
    {
        // 'debug' so the assertion can also prove the client-error lines are
        // *not* at error level (proof 7 keeps caller refusals at warn).
        $kernel = $this->boot(['logLevel' => 'debug']);
        $logPath = $this->root . '/var/log/app.log';

        $clientRefusal = $kernel->handle($this->request('POST', [
            new UploadedFile('file', '/nonexistent', 0, \UPLOAD_ERR_NO_FILE, 'absent.jpg'),
        ]));

        self::assertSame(400, $clientRefusal->status);

        $response = $kernel->handle($this->request('POST', [
            new UploadedFile('file', '/nonexistent', 0, $errorCode, 'hostile.jpg', 'image/jpeg'),
        ]));

        // The frozen generic envelope, and nothing else: the body must not
        // carry the PHP error number, a path, the classification or any detail.
        self::assertSame(500, $response->status);
        $body = $response->decodedBody();

        /** @var array<string, string> $messages */
        $messages = TestEnvironment::artifacts()->httpContract()['errorMessages'];

        self::assertIsArray($body);
        self::assertSame(['error'], array_keys($body));
        self::assertIsArray($body['error']);
        self::assertSame(['code', 'message', 'requestId'], array_keys($body['error']));
        self::assertSame('INTERNAL_ERROR', $body['error']['code']);
        self::assertSame($messages['INTERNAL_ERROR'], $body['error']['message']);

        foreach (['/nonexistent', 'hostile.jpg', 'PHP_UPLOAD_HOST_FAULT', 'UPLOAD_ERR'] as $needle) {
            self::assertStringNotContainsString($needle, $response->body, "body leaks {$needle}");
        }

        // The log: one error-level line naming the stable classification and
        // the PHP upload error code — and no path and no client filename — and
        // the caller refusal stays a warning, never an error.
        $log = (string) @file_get_contents($logPath);
        self::assertNotSame('', $log, 'no log lines were written');

        $lines = array_values(array_filter(
            explode("\n", $log),
            static fn (string $line): bool => $line !== '',
        ));

        $levels = [];
        $messages = [];

        foreach ($lines as $line) {
            /** @var array<string, mixed> $entry */
            $entry = json_decode($line, true);
            self::assertIsArray($entry, "log line is not JSON: {$line}");
            $levels[] = $entry['level'];
            $messages[] = $entry['message'];
        }

        $hostIndex = array_search('Media upload refused: the host could not take the upload.', $messages, true);
        self::assertNotFalse($hostIndex, 'no host-fault log line');
        self::assertSame('error', $levels[$hostIndex]);

        $entry = json_decode($lines[$hostIndex], true);
        self::assertIsArray($entry);
        self::assertSame('PHP_UPLOAD_HOST_FAULT', $entry['classification']);
        self::assertSame($errorCode, $entry['phpErrorCode']);

        self::assertStringNotContainsString('/nonexistent', $lines[$hostIndex]);
        self::assertStringNotContainsString('hostile.jpg', $lines[$hostIndex]);

        $clientIndex = array_search('Media upload refused.', $messages, true);
        self::assertNotFalse($clientIndex, 'no client-refusal log line');
        self::assertSame('warn', $levels[$clientIndex]);
    }

    public function testABodyDiscardedByPostMaxSizeIsA413RatherThanAMissingFile(): void
    {
        // The silent overflow: PHP throws the body away, leaves `$_FILES` empty
        // and reports nothing. Without this branch the caller would be told they
        // forgot to attach a file, which is both wrong and unactionable.
        $kernel = $this->boot();

        $response = $kernel->handle(new Request(
            'POST',
            '/api/admin/media',
            $this->authHeaders() + [
                'content-type' => 'multipart/form-data; boundary=----eszter',
                'content-length' => '4194304',
            ],
        ));

        self::assertSame(413, $response->status);
        self::assertSame('PAYLOAD_TOO_LARGE', $this->errorCodeOf($response));
    }

    public function testPostMaxSizeDiscardIsNotConflatedWithAHostFault(): void
    {
        // Proof 8 of ESZ-135: the silent post_max_size overflow is a 413 that
        // belongs to the caller's file being too big — logged at warn like a
        // client error, never reclassified as the error-level host fault a
        // NO_TMP_DIR/CANT_WRITE/EXTENSION code produces.
        $kernel = $this->boot(['logLevel' => 'debug']);
        $logPath = $this->root . '/var/log/app.log';

        $response = $kernel->handle(new Request(
            'POST',
            '/api/admin/media',
            $this->authHeaders() + [
                'content-type' => 'multipart/form-data; boundary=----eszter',
                'content-length' => '4194304',
            ],
        ));

        self::assertSame(413, $response->status);
        self::assertSame('PAYLOAD_TOO_LARGE', $this->errorCodeOf($response));
        self::assertStringNotContainsString('INTERNAL_ERROR', $response->body);

        $log = (string) @file_get_contents($logPath);
        $lines = array_values(array_filter(
            explode("\n", $log),
            static fn (string $line): bool => $line !== '',
        ));

        $discard = null;
        foreach ($lines as $line) {
            /** @var array<string, string> $entry */
            $entry = json_decode($line, true);

            if (!\is_array($entry)) {
                continue;
            }

            if ($entry['message'] === 'Media upload discarded before it reached the script.') {
                $discard = $entry;

                break;
            }
        }

        self::assertNotNull($discard, 'the discard is not logged');
        self::assertSame('warn', $discard['level'], 'the discard log line is not warn');

        // The host-fault classification never appears on this path, and the
        // recovery never answers INTERNAL_ERROR.
        self::assertStringNotContainsString('PHP_UPLOAD_HOST_FAULT', $log);
    }

    public function testARequestDeclaringMoreThanTheRouteLimitIsRejectedBeforeRouting(): void
    {
        $kernel = $this->boot();
        $declared = $kernel->media->requestLimitBytes() + 1;

        $response = $kernel->handle(new Request(
            'POST',
            '/api/admin/media',
            $this->authHeaders() + [
                'content-type' => 'multipart/form-data; boundary=----eszter',
                'content-length' => (string) $declared,
            ],
        ));

        self::assertSame(413, $response->status);
        self::assertSame('PAYLOAD_TOO_LARGE', $this->errorCodeOf($response));
    }

    public function testTheJsonBodyLimitIsUnchangedEverywhereElse(): void
    {
        // `media.uploadIsBoundedIndependentlyOfTheJsonLimit`. The upload route's
        // 8 MB must not have become the global limit, or every unauthenticated
        // route would now accept 8 MB of JSON to parse.
        $kernel = $this->boot();
        $oversized = str_repeat('x', $kernel->requestBodyLimitBytes + 1);

        self::assertLessThan($kernel->media->uploadLimitBytes, \strlen($oversized));

        foreach (['/api/health', '/api/content', '/api/admin/content/draft'] as $path) {
            $response = $kernel->handle(new Request(
                'POST',
                $path,
                ['content-type' => 'application/json'],
                $oversized,
            ));

            self::assertSame(400, $response->status, $path);
            self::assertSame('INVALID_JSON', $this->errorCodeOf($response), $path);
        }

        // And a body of that size on the upload route is not refused by the
        // *limit* — it gets as far as being judged on its content.
        $response = $kernel->handle(new Request(
            'POST',
            '/api/admin/media',
            $this->authHeaders() + ['content-type' => 'multipart/form-data; boundary=x'],
            '',
        ));

        self::assertSame(400, $response->status);
        self::assertSame('VALIDATION_FAILED', $this->errorCodeOf($response));
    }

    // ── The parts themselves ────────────────────────────────────────────────

    public function testAPartUnderTheWrongNameIsRefused(): void
    {
        $kernel = $this->boot();
        $path = $this->transport->stage($this->root, MediaFixtures::jpeg());

        $response = $kernel->handle($this->request('POST', [
            new UploadedFile('avatar', $path, 100, \UPLOAD_ERR_OK, 'photo.jpg', 'image/jpeg'),
        ]));

        self::assertSame(400, $response->status);
        $this->assertNothingWasLeftBehind();
    }

    public function testMoreThanOnePartIsRefused(): void
    {
        // An endpoint that picked the part it recognised would change behaviour
        // the day a caller attached a second one, and would apply its limits to
        // the part it looked at rather than to what was sent.
        $kernel = $this->boot();
        $first = $this->transport->stage($this->root, MediaFixtures::jpeg());
        $second = $this->transport->stage($this->root, MediaFixtures::png());

        $response = $kernel->handle($this->request('POST', [
            new UploadedFile('file', $first, 100, \UPLOAD_ERR_OK, 'a.jpg', 'image/jpeg'),
            new UploadedFile('file', $second, 100, \UPLOAD_ERR_OK, 'b.png', 'image/png'),
        ]));

        self::assertSame(400, $response->status);
        $this->assertNothingWasLeftBehind();
    }

    public function testAPathTheRequestDidNotUploadIsRefused(): void
    {
        // The `is_uploaded_file()` guarantee. A `$_FILES` entry naming a file the
        // request did not upload must not be read, however real that file is —
        // otherwise an attacker who could influence the array could have the
        // server ingest, re-encode and *publish* an arbitrary local file.
        $kernel = $this->boot();
        $planted = $this->root . '/planted.jpg';
        file_put_contents($planted, MediaFixtures::jpeg());

        $response = $kernel->handle($this->request('POST', [
            new UploadedFile('file', $planted, 100, \UPLOAD_ERR_OK, 'photo.jpg', 'image/jpeg'),
        ]));

        self::assertSame(400, $response->status);
        self::assertFileExists($planted, 'the planted file was consumed');
        $this->assertNothingWasLeftBehind();
    }

    public function testAnEmptyRequestIsAMissingFileRatherThanAnError(): void
    {
        $kernel = $this->boot();
        $response = $kernel->handle($this->request('POST', []));

        self::assertSame(400, $response->status);
        self::assertSame('VALIDATION_FAILED', $this->errorCodeOf($response));
    }

    // ── Leakage ─────────────────────────────────────────────────────────────

    public function testNoMediaResponseNamesAServerPath(): void
    {
        // `media.responsesNeverNameServerPaths`, over a success and every kind of
        // refusal, because the leak that matters is the one on the error path.
        $kernel = $this->boot();

        $responses = [
            $this->upload($kernel, MediaFixtures::jpeg()),
            $this->upload($kernel, MediaFixtures::phpScript(), 'x.jpg', 'image/jpeg'),
            $this->upload($kernel, MediaFixtures::truncatedJpeg(), 'x.jpg', 'image/jpeg'),
            $kernel->handle($this->request('GET', [])),
        ];

        foreach ($responses as $index => $response) {
            foreach (
                [
                    $this->root,
                    'media-originals',
                    '.intake',
                    '.staging-',
                    'media-library.json',
                    '/tmp',
                    'Eszter\\',
                    'finfo',
                    'imagecreate',
                    'MEDIA_REJECTED',
                ] as $needle
            ) {
                self::assertStringNotContainsString((string) $needle, $response->body, "#{$index}");
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /**
     * @param array<string, mixed> $configOverrides Merged over the generated
     *        deployment, so a test can boot at 'debug' to observe log levels.
     */
    private function boot(array $configOverrides = []): Kernel
    {
        $configPath = TestEnvironment::writeDeployment($this->root, $configOverrides);
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

    /** @param list<UploadedFile> $uploads */
    private function request(string $method, array $uploads): Request
    {
        return new Request(
            $method,
            '/api/admin/media',
            $this->authHeaders() + ($method === 'POST'
                ? ['content-type' => 'multipart/form-data; boundary=----eszter']
                : []),
            '',
            $uploads,
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

    private function upload(
        Kernel $kernel,
        string $bytes,
        string $fileName = 'photo.jpg',
        string $declaredType = 'image/jpeg',
    ): Response {
        $path = $this->transport->stage($this->root, $bytes);

        return $kernel->handle($this->request('POST', [
            new UploadedFile(
                'file',
                $path,
                \strlen($bytes),
                \UPLOAD_ERR_OK,
                $fileName,
                $declaredType,
            ),
        ]));
    }

    /** @return array<string, mixed> */
    private function assetFrom(Response $response): array
    {
        $body = $response->decodedBody();

        self::assertIsArray($body);
        self::assertArrayHasKey('asset', $body);
        self::assertIsArray($body['asset']);

        /** @var array<string, mixed> */
        return $body['asset'];
    }

    private function errorCodeOf(Response $response): string
    {
        $body = $response->decodedBody();

        self::assertIsArray($body);

        return (string) $body['error']['code'];
    }

    /**
     * Asserts a refusal was total: no derivative, no original, no intake file and
     * no catalogue entry.
     *
     * This is `media.finalisationLeavesNoPartialState`, and it is asserted after
     * every refusal rather than once, because each refusal exits the pipeline at a
     * different point and the residue each one could leave is different.
     */
    private function assertNothingWasLeftBehind(): void
    {
        self::assertSame([], $this->entriesOf($this->publicMedia()), 'a file survived under /media/');
        self::assertSame(
            [],
            // The intake *directory* is expected; a file inside it is not, and
            // that is what the next assertion covers.
            array_values(array_diff($this->entriesOf($this->originals()), ['.intake'])),
            'an original survived',
        );
        self::assertSame([], $this->entriesOf($this->intake()), 'an intake file survived');
        self::assertFileDoesNotExist(
            $this->root . '/data/content/' . MediaLibrary::INDEX_FILE,
            'a refusal wrote the catalogue',
        );
    }

    /** @return list<string> Everything in $directory except the dot entries. */
    private function entriesOf(string $directory): array
    {
        if (!is_dir($directory)) {
            return [];
        }

        return array_values(array_diff(scandir($directory) ?: [], ['.', '..']));
    }

    /** @return list<string> Entries that are not managed assets. */
    private function strayNames(string $directory): array
    {
        return array_values(array_filter(
            $this->entriesOf($directory),
            static fn (string $entry): bool
                => preg_match('/^med_[0-9a-f]{32}\.(jpg|png|webp)$/', $entry) !== 1,
        ));
    }

    private function publicMedia(): string
    {
        return $this->root . '/public_html/media';
    }

    private function originals(): string
    {
        return $this->root . '/data/media-originals';
    }

    private function intake(): string
    {
        return $this->originals() . '/.intake';
    }

    /** @return array<string, string|false> */
    private function storedContent(): array
    {
        return [
            'draft' => @file_get_contents($this->root . '/data/content/draft.json'),
            'published' => @file_get_contents($this->root . '/data/content/published.json'),
        ];
    }
}
