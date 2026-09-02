<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaLibrary;
use Eszter\Storage\StorageException;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The media permission boundary, at the library layer (ESZ-103).
 *
 * Direct construction rather than a kernel boot: the negative proofs inject a
 * failing mode seam into {@see MediaLibrary::publishAsset()}, which no kernel
 * seam reaches. The unwinding assertions are the same ones the upload route
 * would make — placed files are removed, nothing is catalogued.
 */
final class MediaLibraryFileModeTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const MIME = 'image/jpeg';

    private string $root;
    private string $contentDir;
    private string $originalsDir;
    private string $publicMediaDir;
    private string $tmpDir;
    private string $lockDir;
    private MediaContract $contract;
    private ContractArtifacts $artifacts;
    private StructuralValidator $structural;
    private FrozenClock $clock;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-media-mode');
        $this->contentDir = $this->root . '/data/content';
        $this->originalsDir = $this->root . '/data/media-originals';
        $this->publicMediaDir = $this->root . '/public_html/media';
        $this->tmpDir = $this->root . '/var/tmp';
        $this->lockDir = $this->root . '/data/locks';

        foreach (
            [$this->contentDir, $this->originalsDir, $this->publicMediaDir, $this->tmpDir, $this->lockDir] as $directory
        ) {
            mkdir($directory, 0o700, true);
        }

        $this->artifacts = TestEnvironment::artifacts();
        $this->contract = MediaContract::fromArtifacts($this->artifacts);
        $this->structural = new StructuralValidator($this->artifacts);
        $this->clock = new FrozenClock(self::NOW);
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    private function library(?\Closure $setFileMode = null): MediaLibrary
    {
        return new MediaLibrary(
            $this->contract,
            $this->contentDir,
            $this->originalsDir,
            $this->publicMediaDir,
            $this->tmpDir,
            $this->lockDir,
            $this->artifacts,
            $this->structural,
            $this->clock,
            $setFileMode,
        );
    }

    /** @return array{id: string, fileName: string, intake: string, staging: string, metadata: array<string, mixed>} */
    private function publishableAsset(): array
    {
        $id = $this->contract->newAssetId();
        $fileName = $this->contract->fileNameFor($id, self::MIME);

        $intake = $this->originalsDir . '/.intake/' . bin2hex(random_bytes(8));
        $staging = $this->publicMediaDir . '/.staging-' . bin2hex(random_bytes(8));

        mkdir($this->originalsDir . '/.intake', 0o700, true);
        file_put_contents($intake, 'original-bytes');
        file_put_contents($staging, 'derivative-bytes');

        $metadata = [
            'id' => $id,
            'path' => $this->contract->publicPathFor($id, self::MIME),
            'mimeType' => self::MIME,
            'byteSize' => 16,
            'width' => 64,
            'height' => 48,
            'uploadedAt' => $this->clock->nowIso(),
        ];

        return [
            'id' => $id,
            'fileName' => $fileName,
            'intake' => $intake,
            'staging' => $staging,
            'metadata' => $metadata,
        ];
    }

    /** @return list<string> Everything in $directory except the dot entries. */
    private function entriesOf(string $directory): array
    {
        return array_values(array_diff(scandir($directory) ?: [], ['.', '..']));
    }

    public function testAPublishCarriesThePolicyModesOnOriginalDerivativeAndCatalogue(): void
    {
        $library = $this->library();
        $asset = $this->publishableAsset();

        $stored = $library->publishAsset($asset['id'], $asset['intake'], $asset['staging'], $asset['metadata']);

        self::assertSame($asset['id'], $stored['id']);
        // Private boundary: original and catalogue at 0640; the derivative is
        // the intentional public exception at 0644.
        self::assertSame(
            MediaLibrary::PRIVATE_ORIGINAL_MODE,
            fileperms($this->originalsDir . '/' . $asset['fileName']) & 0o777,
        );
        self::assertSame(
            MediaLibrary::PUBLIC_DERIVATIVE_MODE,
            fileperms($this->publicMediaDir . '/' . $asset['fileName']) & 0o777,
        );
        self::assertSame(0o640, fileperms($this->contentDir . '/' . MediaLibrary::INDEX_FILE) & 0o777);
    }

    public function testAnOriginalThatCannotBeRestrictedIsUnwoundAndNeverCatalogued(): void
    {
        // The seam refuses only the private-original restriction; every other
        // mode application (derivative 0644) is real.
        $library = $this->library(static function (string $path, int $mode): bool {
            return $mode === MediaLibrary::PRIVATE_ORIGINAL_MODE ? false : chmod($path, $mode);
        });
        $asset = $this->publishableAsset();

        try {
            $library->publishAsset($asset['id'], $asset['intake'], $asset['staging'], $asset['metadata']);
            self::fail('an unrestrictable original was catalogued');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::WRITE_FAILED, $exception->storageCode);
        }

        self::assertFileDoesNotExist(
            $this->contentDir . '/' . MediaLibrary::INDEX_FILE,
            'a failed publish wrote the catalogue',
        );
        self::assertFileDoesNotExist(
            $this->originalsDir . '/' . $asset['fileName'],
            'the original survived the unwind',
        );
        self::assertFileDoesNotExist(
            $this->publicMediaDir . '/' . $asset['fileName'],
            'the derivative was renamed into place',
        );
        self::assertSame(['.intake'], $this->entriesOf($this->originalsDir));
        self::assertSame([], $this->entriesOf($this->intakeDirectory()));
    }

    public function testADerivativeThatCannotBeRestrictedUnwindsBothFilesAndCataloguesNothing(): void
    {
        // Both files were already renamed into place when the derivative
        // restriction fails; the unwind must remove them both.
        $library = $this->library(static function (string $path, int $mode): bool {
            return $mode === MediaLibrary::PUBLIC_DERIVATIVE_MODE ? false : chmod($path, $mode);
        });
        $asset = $this->publishableAsset();

        try {
            $library->publishAsset($asset['id'], $asset['intake'], $asset['staging'], $asset['metadata']);
            self::fail('an unrestrictable derivative was catalogued');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::WRITE_FAILED, $exception->storageCode);
        }

        self::assertFileDoesNotExist($this->contentDir . '/' . MediaLibrary::INDEX_FILE);
        self::assertSame(['.intake'], $this->entriesOf($this->originalsDir));
        self::assertSame([], $this->entriesOf($this->publicMediaDir));
        self::assertSame([], $this->entriesOf($this->intakeDirectory()));
    }

    private function intakeDirectory(): string
    {
        return $this->originalsDir . '/.intake';
    }
}
