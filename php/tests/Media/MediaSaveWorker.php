<?php

declare(strict_types=1);

use Eszter\Kernel;
use Eszter\Media\DanglingMediaReferenceException;
use Eszter\Storage\MediaContentLock;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * ESZ-100 / ESZ-147 worker: commits a draft save that references one media asset.
 *
 * Invoked as an independent process by MediaDeleteConcurrencyTest so the save
 * contends for the media/content boundary through real flock(2), like a real
 * editor save would. Modes:
 *
 *   save       saveDraft(expectedRevision, content-with-$assetPath), then exit;
 *              the marker file is created just before the save is attempted.
 *   hold-save  the same save, but the boundary is first taken shared and held
 *              until the release file appears, so the caller can prove a delete
 *              waiting on the boundary cannot proceed while this save is in
 *              flight.
 *
 * A save refused by the ESZ-147 managed-reference guard (the saved document
 * would persist a managed src the catalogue does not name) is an expected
 * outcome, reported as `REFUSED` with exit 0; any other failure is an error.
 *
 * Events are appended to the shared log file: `save-attempting`,
 * `save-committed:<revision>`, `save-released`, `save-returned:<revision|REFUSED>`.
 */

/** @var list<string> $argv */
$argv = $_SERVER['argv'] ?? [];

/** Appends one event line to the shared log. */
function saveWorkerEvent(string $logPath, string $line): void
{
    file_put_contents($logPath, $line . "\n", FILE_APPEND);
}

/**
 * The canonical document with the hero visual pointing at $assetPath.
 *
 * @return array<string, mixed>
 */
function saveWorkerContent(string $assetPath): array
{
    $content = TestEnvironment::artifacts()->canonicalSiteContent();
    /** @var array<string, mixed> $hero */
    $hero = $content['hero'];
    /** @var array<string, mixed> $visual */
    $visual = $hero['visual'];
    $visual['src'] = $assetPath;
    $hero['visual'] = $visual;
    $content['hero'] = $hero;

    return $content;
}

$arguments = array_pad($argv, 8, '');
[$script, $configPath, $expectedRevision, $assetPath, $mode, $logPath, $markerPath, $releasePath] = $arguments;

if (
    $configPath === ''
    || $expectedRevision === ''
    || $assetPath === ''
    || !\in_array($mode, ['save', 'hold-save'], true)
    || $logPath === ''
    || $markerPath === ''
    || ($mode === 'hold-save' && $releasePath === '')
) {
    fwrite(STDERR, "save worker arguments missing or invalid\n");
    exit(2);
}

try {
    $kernel = Kernel::boot($configPath);
    $storage = $kernel->storage;

    if ($mode === 'save') {
        file_put_contents($markerPath, '1');
        saveWorkerEvent($logPath, 'save-attempting');

        try {
            $saved = $storage->saveDraft((int) $expectedRevision, saveWorkerContent($assetPath));
            saveWorkerEvent($logPath, 'save-returned:' . $saved['revision']);
            fwrite(STDOUT, 'SAVED rev=' . $saved['revision'] . "\n");
        } catch (DanglingMediaReferenceException) {
            // ESZ-147: the asset this save would reference was deleted before
            // the save acquired the boundary — an expected refusal.
            saveWorkerEvent($logPath, 'save-returned:REFUSED');
            fwrite(STDOUT, "REFUSED\n");
        }
        exit(0);
    }

    // hold-save: the boundary is held shared across the whole save and kept
    // held afterwards until the caller releases it.
    $boundary = new MediaContentLock($kernel->config->lockDir);
    $boundary->withShared(
        static function () use (
            $storage,
            $expectedRevision,
            $assetPath,
            $logPath,
            $markerPath,
            $releasePath,
        ): void {
            file_put_contents($markerPath, '1');
            saveWorkerEvent($logPath, 'save-inside');

            try {
                $saved = $storage->saveDraft((int) $expectedRevision, saveWorkerContent($assetPath));
                saveWorkerEvent($logPath, 'save-committed:' . $saved['revision']);
            } catch (DanglingMediaReferenceException) {
                saveWorkerEvent($logPath, 'save-committed:REFUSED');
            }

            $deadline = microtime(true) + 30.0;
            while (!is_file($releasePath)) {
                if (microtime(true) > $deadline) {
                    throw new \RuntimeException('save worker timed out waiting for its release file.');
                }
                usleep(10_000);
            }
        },
    );
    saveWorkerEvent($logPath, 'save-released');
    fwrite(STDOUT, "SAVED-HOLD\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
