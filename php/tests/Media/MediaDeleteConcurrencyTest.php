<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Media\MediaReferences;
use Eszter\Media\UploadedFile;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Auth\InMemoryAccountDirectory;
use Eszter\Tests\Auth\InMemorySessionStore;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-100 / ESZ-147 — content save/publish vs media delete, both linearization
 * orders, in real processes.
 *
 * The delete holds the {@see \Eszter\Storage\MediaContentLock} boundary
 * exclusively from its reference check to its catalogue commit; every content
 * write that can make a media reference durable holds it shared. These tests
 * prove, with two independent PHP processes contending through real `flock(2)`,
 * that whichever side acquires the boundary first is ordered first and the two
 * never overlap:
 *
 *  - **save first**: the save commits a reference while still holding the
 *    boundary shared; the delete, started while that hold is in place, waits and
 *    then observes the committed reference and refuses — the asset is untouched.
 *  - **delete first**: the delete completes its whole check-to-commit critical
 *    section under the exclusive boundary while the save waits on it. Since
 *    ESZ-147 the save that follows is then **refused** by the managed-reference
 *    guard — the document would persist a managed src the catalogue no longer
 *    names — so the deletion is never half-observed and no dangling reference
 *    becomes durable.
 *  - **publish vs delete, both orders** (ESZ-147): a publish that commits a
 *    reference while holding the boundary shared makes a concurrent delete wait
 *    and then refuse with the reference visible in the published document; a
 *    delete that holds the boundary exclusively while a publish waits either
 *    refuses first (the stored draft already references the asset) and lets the
 *    publish land whole afterwards. Neither order can produce a published
 *    document that names an asset the catalogue does not carry, and neither
 *    deadlocks.
 *
 * Determinism comes from the choreography (marker and release files), never from
 * timing sleeps: the assertions are about which side completed first and about
 * final state, and each scenario is repeated to shake out deadlocks.
 */
final class MediaDeleteConcurrencyTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const REPEATS = 3;

    private string $root;
    private string $configPath;
    private string $logPath;
    private FakeUploadTransport $transport;
    private InMemorySessionStore $sessionStore;
    private InMemoryAccountDirectory $accounts;
    private string $sessionId;
    private string $csrfToken;

    protected function setUp(): void
    {
        $this->newRoot();
        $this->transport = new FakeUploadTransport();
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    private function newRoot(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-media-concurrency');
    }

    private function startIteration(int $iteration): void
    {
        if ($iteration > 0) {
            TestEnvironment::removeDirectory($this->root);
            $this->newRoot();
        }

        $this->logPath = $this->root . '/events.log';
    }

    // ── Save first: the delete observes the committed reference and refuses ──

    public function testEs100SaveFirstTheDeleteObservesTheReferenceAndRefuses(): void
    {
        if (!\function_exists('proc_open')) {
            self::markTestSkipped('proc_open is unavailable; real concurrency cannot be exercised.');
        }

        for ($iteration = 0; $iteration < self::REPEATS; ++$iteration) {
            $this->startIteration($iteration);
            $kernel = $this->boot();
            $asset = $this->uploadAsset($kernel);
            $id = (string) $asset['id'];
            $path = (string) $asset['path'];
            $markerSave = $this->root . '/marker-save';
            $markerDelete = $this->root . '/marker-delete';
            $releaseSave = $this->root . '/release-save';

            // The save takes the boundary shared, commits a draft that
            // references the asset, and keeps holding the boundary.
            $saver = $this->spawn('MediaSaveWorker.php', [
                $this->configPath, '0', $path, 'hold-save', $this->logPath, $markerSave, $releaseSave,
            ]);
            $this->awaitFile($markerSave, 'save worker');
            $this->awaitLog('save-committed:', 'save worker');

            // The delete starts while the save still holds the boundary; it can
            // only proceed once the save releases, and must then see the
            // committed reference.
            $deleter = $this->spawn('MediaDeleteWorker.php', [
                $this->configPath, $id, 'delete', $this->logPath, $markerDelete,
            ]);
            $this->awaitFile($markerDelete, 'delete worker');

            touch($releaseSave);

            [$saveExit, $saveOut, $saveErr] = $this->reap($saver, 'save worker');
            self::assertSame(0, $saveExit, $saveErr);
            self::assertStringContainsString('SAVED-HOLD', $saveOut);

            [$deleteExit, $deleteOut, $deleteErr] = $this->reap($deleter, 'delete worker');
            self::assertSame(0, $deleteExit, $deleteErr);
            self::assertStringContainsString('REFUSED', $deleteOut);

            // Linearization: the save committed before the delete returned, and
            // the delete refused — the asset is exactly as it was.
            self::assertTrue(
                $this->logIndex('save-committed:') < $this->logIndex('delete-returned:REFUSED'),
                'the delete returned before the save that referenced the asset had committed',
            );
            self::assertSame([$asset], $this->assetsOf($kernel->handle($this->listRequest())));
            self::assertFileExists($this->publicMedia() . '/' . basename($path));
            self::assertFileExists($this->originals() . '/' . basename($path));
            self::assertSame([], $this->deletingLeftovers($this->publicMedia()));
            self::assertSame([], $this->deletingLeftovers($this->originals()));

            $draft = $kernel->storage->readDraft();
            self::assertSame(1, $draft['revision']);
            self::assertTrue(
                MediaReferences::isReferenced((array) $draft['content'], $path),
                'the save that refused the delete did not persist its reference',
            );
        }
    }

    // ── Delete first: the save waits behind the whole deletion, then refuses ──
    //
    // ESZ-100 proved the delete's whole check-to-commit critical section runs
    // under the exclusive boundary. ESZ-147 gives the save that follows its
    // verdict: the asset is gone, so the save — whose document would reference
    // it — is refused by the managed-reference guard instead of committing a
    // dangling reference.

    public function testEs100DeleteFirstBlocksTheSaveUntilTheDeletionIsCommitted(): void
    {
        if (!\function_exists('proc_open')) {
            self::markTestSkipped('proc_open is unavailable; real concurrency cannot be exercised.');
        }

        for ($iteration = 0; $iteration < self::REPEATS; ++$iteration) {
            $this->startIteration($iteration);
            $kernel = $this->boot();
            $asset = $this->uploadAsset($kernel);
            $id = (string) $asset['id'];
            $path = (string) $asset['path'];
            $markerDelete = $this->root . '/marker-delete';
            $markerSave = $this->root . '/marker-save';
            $releaseDelete = $this->root . '/release-delete';

            // The delete owns the boundary exclusively across its whole
            // check-to-commit critical section and keeps holding it.
            $deleter = $this->spawn('MediaDeleteWorker.php', [
                $this->configPath, $id, 'hold-delete', $this->logPath, $markerDelete, $releaseDelete,
            ]);
            $this->awaitFile($markerDelete, 'delete worker');
            $this->awaitLog('delete-done:', 'delete worker');

            // The save (which would reference the asset) starts while the delete
            // still holds the boundary; it must not commit until the deletion is
            // complete. The marker is written just before the save is attempted,
            // so its presence proves the attempt began under the exclusive hold.
            $saver = $this->spawn('MediaSaveWorker.php', [
                $this->configPath, '0', $path, 'save', $this->logPath, $markerSave, '',
            ]);
            $this->awaitFile($markerSave, 'save worker');

            touch($releaseDelete);

            [$deleteExit, $deleteOut, $deleteErr] = $this->reap($deleter, 'delete worker');
            self::assertSame(0, $deleteExit, $deleteErr);
            self::assertStringContainsString('DELETED-HOLD', $deleteOut);

            [$saveExit, $saveOut, $saveErr] = $this->reap($saver, 'save worker');
            self::assertSame(0, $saveExit, $saveErr);
            // ESZ-147: the deletion is committed, so the managed-reference guard
            // refuses the save — no write crossed the delete, and the document
            // that would have referenced the deleted asset never becomes durable.
            self::assertStringContainsString('REFUSED', $saveOut);

            // Linearization: the save attempted while the delete held the
            // boundary, and its refusal came only after the deletion finished.
            self::assertTrue(
                $this->logIndex('delete-done:DELETED') < $this->logIndex('save-returned:REFUSED'),
                'the save returned before the deletion had finished',
            );
            self::assertSame([], $this->assetsOf($kernel->handle($this->listRequest())));
            self::assertSame([], $this->deletingLeftovers($this->publicMedia()));
            self::assertSame([], $this->deletingLeftovers($this->originals()));
            self::assertFileDoesNotExist($this->publicMedia() . '/' . basename($path));
            self::assertFileDoesNotExist($this->originals() . '/' . basename($path));

            // The refused save left the draft at its seeded head, unreferenced.
            $draft = $kernel->storage->readDraft();
            self::assertSame(0, $draft['revision']);
            self::assertFalse(
                MediaReferences::isReferenced((array) $draft['content'], $path),
                'the refused save still persisted its reference',
            );
        }
    }

    // ── Publish vs delete, both orders (ESZ-147) ──────────────────────────
    //
    // A publish commits the stored draft into published.json; the draft already
    // references the asset, so whichever side acquires the boundary first
    // decides the outcome, and neither outcome may leave a published document
    // naming an asset the catalogue does not carry.

    public function testEs147PublishFirstTheDeleteObservesThePublishedReferenceAndRefuses(): void
    {
        if (!\function_exists('proc_open')) {
            self::markTestSkipped('proc_open is unavailable; real concurrency cannot be exercised.');
        }

        for ($iteration = 0; $iteration < self::REPEATS; ++$iteration) {
            $this->startIteration($iteration);
            $kernel = $this->boot();
            $asset = $this->uploadAsset($kernel);
            $id = (string) $asset['id'];
            $path = (string) $asset['path'];
            $this->saveDraftReferencing($kernel, $path);
            $revision = $kernel->storage->draftRevision();
            $markerPublish = $this->root . '/marker-publish';
            $markerDelete = $this->root . '/marker-delete';
            $releasePublish = $this->root . '/release-publish';

            // The publish takes the boundary shared, commits the reference into
            // published.json, and keeps holding the boundary.
            $publisher = $this->spawn('MediaPublishWorker.php', [
                $this->configPath, (string) $revision, 'hold-publish', $this->logPath, $markerPublish, $releasePublish,
            ]);
            $this->awaitFile($markerPublish, 'publish worker');
            $this->awaitLog('publish-committed:' . $revision, 'publish worker');

            // The delete starts while the publish still holds the boundary; it
            // can only proceed once the publish releases, and must then see the
            // committed reference in the published document.
            $deleter = $this->spawn('MediaDeleteWorker.php', [
                $this->configPath, $id, 'delete', $this->logPath, $markerDelete,
            ]);
            $this->awaitFile($markerDelete, 'delete worker');

            touch($releasePublish);

            [$publishExit, $publishOut, $publishErr] = $this->reap($publisher, 'publish worker');
            self::assertSame(0, $publishExit, $publishErr);
            self::assertStringContainsString('PUBLISHED-HOLD', $publishOut);

            [$deleteExit, $deleteOut, $deleteErr] = $this->reap($deleter, 'delete worker');
            self::assertSame(0, $deleteExit, $deleteErr);
            self::assertStringContainsString('REFUSED', $deleteOut);

            // Linearization: the publish committed before the delete returned,
            // and the delete refused — the asset is exactly as it was.
            self::assertTrue(
                $this->logIndex('publish-committed:') < $this->logIndex('delete-returned:REFUSED'),
                'the delete returned before the publish that referenced the asset had committed',
            );
            self::assertSame([$asset], $this->assetsOf($kernel->handle($this->listRequest())));
            self::assertFileExists($this->publicMedia() . '/' . basename($path));
            self::assertFileExists($this->originals() . '/' . basename($path));
            self::assertSame([], $this->deletingLeftovers($this->publicMedia()));
            self::assertSame([], $this->deletingLeftovers($this->originals()));

            // The published document now carries the reference the delete saw.
            $published = $kernel->storage->readPublished();
            self::assertSame($revision, $published['revision']);
            self::assertTrue(
                MediaReferences::isReferenced((array) $published['content'], $path),
                'the publish that refused the delete did not persist its reference',
            );
        }
    }

    public function testEs147DeleteFirstThePublishWaitsThenLandsWholeAgainstTheRefusal(): void
    {
        if (!\function_exists('proc_open')) {
            self::markTestSkipped('proc_open is unavailable; real concurrency cannot be exercised.');
        }

        for ($iteration = 0; $iteration < self::REPEATS; ++$iteration) {
            $this->startIteration($iteration);
            $kernel = $this->boot();
            $asset = $this->uploadAsset($kernel);
            $id = (string) $asset['id'];
            $path = (string) $asset['path'];
            $this->saveDraftReferencing($kernel, $path);
            $revision = $kernel->storage->draftRevision();
            $markerDelete = $this->root . '/marker-delete';
            $markerPublish = $this->root . '/marker-publish';
            $releaseDelete = $this->root . '/release-delete';

            // The delete owns the boundary exclusively and runs its reference
            // check first: the stored draft already references the asset, so it
            // refuses — then keeps holding the boundary.
            $deleter = $this->spawn('MediaDeleteWorker.php', [
                $this->configPath, $id, 'hold-delete', $this->logPath, $markerDelete, $releaseDelete,
            ]);
            $this->awaitFile($markerDelete, 'delete worker');
            $this->awaitLog('delete-done:REFUSED', 'delete worker');

            // The publish starts while the delete still holds the boundary; it
            // must not commit until the deletion's refusal is complete.
            $publisher = $this->spawn('MediaPublishWorker.php', [
                $this->configPath, (string) $revision, 'publish', $this->logPath, $markerPublish, '',
            ]);
            $this->awaitFile($markerPublish, 'publish worker');

            touch($releaseDelete);

            [$deleteExit, $deleteOut, $deleteErr] = $this->reap($deleter, 'delete worker');
            self::assertSame(0, $deleteExit, $deleteErr);
            self::assertStringContainsString('REFUSED-HOLD', $deleteOut);

            [$publishExit, $publishOut, $publishErr] = $this->reap($publisher, 'publish worker');
            self::assertSame(0, $publishExit, $publishErr);
            self::assertStringContainsString('PUBLISHED', $publishOut);

            // Linearization: the delete's refusal completed before the publish
            // returned — no publish crossed the delete's critical section.
            self::assertTrue(
                $this->logIndex('delete-done:REFUSED') < $this->logIndex('publish-returned:'),
                'the publish returned before the delete had finished',
            );
            self::assertSame([$asset], $this->assetsOf($kernel->handle($this->listRequest())));
            self::assertFileExists($this->publicMedia() . '/' . basename($path));
            self::assertSame([], $this->deletingLeftovers($this->publicMedia()));
            self::assertSame([], $this->deletingLeftovers($this->originals()));

            // The publish landed whole afterwards, and the published document
            // references an asset the catalogue still carries: no dangling
            // published reference, no deadlock.
            $published = $kernel->storage->readPublished();
            self::assertSame($revision, $published['revision']);
            self::assertTrue(
                MediaReferences::isReferenced((array) $published['content'], $path),
                'the post-refusal publish did not persist its full document',
            );
        }
    }

    // ── Fixture ─────────────────────────────────────────────────────────────

    private function boot(): Kernel
    {
        $this->configPath = TestEnvironment::writeDeployment($this->root);
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
            $this->configPath,
            $clock,
            null,
            null,
            $this->accounts,
            $this->sessionStore,
            $this->transport,
        );
    }

    /** @return array<string, mixed> */
    private function uploadAsset(Kernel $kernel): array
    {
        $path = $this->transport->stage($this->root, MediaFixtures::jpeg());
        $response = $kernel->handle(new Request(
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

    /**
     * Saves a draft whose hero visual points at the catalogued $publicPath.
     *
     * Goes through the real storage save, which since ESZ-147 runs the
     * managed-reference guard: the asset was uploaded first, so the save is
     * accepted and the head moves to 1.
     */
    private function saveDraftReferencing(Kernel $kernel, string $publicPath): void
    {
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        /** @var array<string, mixed> $hero */
        $hero = $content['hero'];
        /** @var array<string, mixed> $visual */
        $visual = $hero['visual'];
        $visual['src'] = $publicPath;
        $hero['visual'] = $visual;
        $content['hero'] = $hero;

        $saved = $kernel->storage->saveDraft(0, $content);
        self::assertSame(1, $saved['revision']);
    }

    private function listRequest(): Request
    {
        return new Request('GET', '/api/admin/media', $this->authHeaders());
    }

    /** @return array<string, string> */
    private function authHeaders(): array
    {
        return [
            'cookie' => '__Host-eszter_session=' . $this->sessionId,
            'x-csrf-token' => $this->csrfToken,
        ];
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

    private function publicMedia(): string
    {
        return $this->root . '/public_html/media';
    }

    private function originals(): string
    {
        return $this->root . '/data/media-originals';
    }

    /** @return list<string> */
    private function deletingLeftovers(string $directory): array
    {
        return glob($directory . '/.deleting-*') ?: [];
    }

    /**
     * Spawns one worker process.
     *
     * @param list<string> $arguments
     * @return array{process: resource, pipes: array<int, resource>}
     */
    private function spawn(string $script, array $arguments): array
    {
        $pipes = [];
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/' . $script, ...$arguments],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        self::assertIsResource($process);
        fclose($pipes[0]);

        return ['process' => $process, 'pipes' => $pipes];
    }

    private function awaitFile(string $path, string $label, float $seconds = 30.0): void
    {
        $deadline = microtime(true) + $seconds;
        do {
            if (is_file($path)) {
                return;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);
        self::fail("{$label} never reached its marker ({$path})");
    }

    private function awaitLog(string $needle, string $label, float $seconds = 30.0): void
    {
        $deadline = microtime(true) + $seconds;
        do {
            if (is_file($this->logPath) && str_contains((string) file_get_contents($this->logPath), $needle)) {
                return;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);
        self::fail("{$label} never logged {$needle}");
    }

    /**
     * Reads a worker to EOF (its exit), then reaps it.
     *
     * @param array{process: resource, pipes: array<int, resource>} $worker
     * @return array{int, string, string} exit code, stdout, stderr
     */
    private function reap(array $worker, string $label, float $seconds = 60.0): array
    {
        $deadline = microtime(true) + $seconds;
        $status = proc_get_status($worker['process']);
        while ($status['running']) {
            if (microtime(true) > $deadline) {
                proc_terminate($worker['process']);
                self::fail("{$label} did not finish within {$seconds}s");
            }
            usleep(20_000);
            $status = proc_get_status($worker['process']);
        }

        $stdout = trim((string) stream_get_contents($worker['pipes'][1]));
        $stderr = trim((string) stream_get_contents($worker['pipes'][2]));
        fclose($worker['pipes'][1]);
        fclose($worker['pipes'][2]);

        return [proc_close($worker['process']), $stdout, $stderr];
    }

    /** The line index of the first event containing $needle, or PHP_INT_MAX. */
    private function logIndex(string $needle): int
    {
        $lines = is_file($this->logPath) ? file($this->logPath, FILE_IGNORE_NEW_LINES) : false;

        if ($lines === false) {
            return PHP_INT_MAX;
        }

        foreach ($lines as $index => $line) {
            if (str_contains($line, $needle)) {
                return $index;
            }
        }

        return PHP_INT_MAX;
    }
}
