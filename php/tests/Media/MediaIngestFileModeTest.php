<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Media\ImagePipeline;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaIngest;
use Eszter\Media\MediaLibrary;
use Eszter\Media\UploadedFile;
use Eszter\Storage\StorageException;
use Eszter\Support\FrozenClock;
use Eszter\Support\Logger;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The intake permission restriction, at the ingest layer (ESZ-103).
 *
 * Direct construction rather than a kernel boot: the negative proof injects a
 * failing mode seam into the ingest, which no kernel seam reaches. The rest of
 * the pipeline is real — real directories, real contract artifacts, real image
 * re-encode, real catalogue write — so the assertions hold on actual bytes and
 * actual modes.
 */
final class MediaIngestFileModeTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;
    private string $contentDir;
    private string $originalsDir;
    private string $publicMediaDir;
    private string $tmpDir;
    private string $lockDir;
    private FakeUploadTransport $transport;
    private MediaContract $contract;
    private ContractArtifacts $artifacts;
    private StructuralValidator $structural;
    private FrozenClock $clock;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-media-ingest-mode');
        $this->contentDir = $this->root . '/data/content';
        $this->originalsDir = $this->root . '/data/media-originals';
        $this->publicMediaDir = $this->root . '/public_html/media';
        $this->tmpDir = $this->root . '/var/tmp';
        $this->lockDir = $this->root . '/data/locks';

        foreach (
            [
                $this->contentDir,
                $this->originalsDir,
                $this->publicMediaDir,
                $this->tmpDir,
                $this->lockDir,
                $this->root . '/var/log',
            ] as $directory
        ) {
            mkdir($directory, 0o700, true);
        }

        $this->transport = new FakeUploadTransport();
        $this->artifacts = TestEnvironment::artifacts();
        $this->contract = MediaContract::fromArtifacts($this->artifacts);
        $this->structural = new StructuralValidator($this->artifacts);
        $this->clock = new FrozenClock(self::NOW);
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    private function ingest(?\Closure $setFileMode = null): MediaIngest
    {
        $library = new MediaLibrary(
            $this->contract,
            $this->contentDir,
            $this->originalsDir,
            $this->publicMediaDir,
            $this->tmpDir,
            $this->lockDir,
            $this->artifacts,
            $this->structural,
            $this->clock,
        );
        $logger = new Logger($this->root . '/var/log/app.log', 'error', $this->clock);

        return new MediaIngest(
            $this->contract,
            new ImagePipeline($this->contract),
            $library,
            $this->structural,
            $this->transport,
            $this->clock,
            $logger,
            $setFileMode,
        );
    }

    /** @return list<UploadedFile> */
    private function upload(): array
    {
        $bytes = MediaFixtures::jpeg();
        $path = $this->transport->stage($this->root, $bytes);

        return [
            new UploadedFile(
                'file',
                $path,
                \strlen($bytes),
                \UPLOAD_ERR_OK,
                'photo.jpg',
                'image/jpeg',
            ),
        ];
    }

    /** @return list<string> Everything in $directory except the dot entries. */
    private function entriesOf(string $directory): array
    {
        return array_values(array_diff(scandir($directory) ?: [], ['.', '..']));
    }

    public function testAnIntakeFileThatCannotBeRestrictedIsRefusedAndEverythingConverges(): void
    {
        $ingest = $this->ingest(static fn (string $path, int $mode): bool => false);

        try {
            $ingest->ingest($this->upload());
            self::fail('an unrestrictable intake file was catalogued');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::WRITE_FAILED, $exception->storageCode);
        }

        // No catalogue entry, no original, no derivative staging, no intake
        // residue: the ingest's own `finally` converges.
        self::assertFileDoesNotExist($this->contentDir . '/' . MediaLibrary::INDEX_FILE);
        self::assertSame(['.intake'], $this->entriesOf($this->originalsDir));
        self::assertSame([], $this->entriesOf($this->originalsDir . '/.intake'));
        self::assertSame([], $this->entriesOf($this->publicMediaDir));
    }

    public function testASuccessfulIngestAppliesTheIntakeModeAndPublishesThePolicyModes(): void
    {
        // The seam replaces only the intake chmod and records the call while
        // still applying the real mode, so the ingestion below proves both that
        // the intake restriction is requested at 0600 and that the stored files
        // carry their policy modes on the real filesystem.
        $calls = [];
        $guard = static function (string $path, int $mode) use (&$calls): bool {
            $calls[] = ['path' => $path, 'mode' => $mode];

            return chmod($path, $mode);
        };

        $asset = $this->ingest($guard)->ingest($this->upload());

        self::assertMatchesRegularExpression('/^med_[0-9a-f]{32}$/', (string) $asset['id']);

        $fileName = $this->contract->fileNameFor((string) $asset['id'], 'image/jpeg');

        // The intake restriction was requested exactly once, at 0600, on a file
        // inside the intake directory.
        self::assertCount(1, $calls);
        self::assertSame(0o600, $calls[0]['mode']);
        self::assertSame($this->originalsDir . '/.intake', \dirname($calls[0]['path']));
        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/', basename($calls[0]['path']));

        // The stored files carry their policy modes on the real filesystem:
        // original and catalogue at 0640, served derivative at 0644.
        self::assertSame(0o640, fileperms($this->originalsDir . '/' . $fileName) & 0o777);
        self::assertSame(0o644, fileperms($this->publicMediaDir . '/' . $fileName) & 0o777);
        self::assertSame(0o640, fileperms($this->contentDir . '/' . MediaLibrary::INDEX_FILE) & 0o777);

        // Intake converged: nothing is left under .intake after the rename.
        self::assertSame([], $this->entriesOf($this->originalsDir . '/.intake'));
    }
}
