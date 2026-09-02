<?php

declare(strict_types=1);

use Eszter\Kernel;
use Eszter\Media\DanglingMediaReferenceException;
use Eszter\Storage\MediaContentLock;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * ESZ-147 worker: publishes the stored draft through the real ContentStorage.
 *
 * Invoked as an independent process by MediaDeleteConcurrencyTest so a publish
 * contends for the media/content boundary through real flock(2), exactly like
 * a `POST /api/admin/content/publish` request. Modes:
 *
 *   publish       publishDraft(expectedRevision) then exit; the marker file is
 *                 created just before the publish is attempted.
 *   hold-publish  the same publish, but the boundary is first taken shared and
 *                 held until the release file appears, so the caller can prove
 *                 a delete waiting on the boundary cannot proceed while this
 *                 publish is in flight.
 *
 * A publish refused by the ESZ-147 managed-reference guard (the stored draft
 * carries a managed src the catalogue does not name) is an expected outcome,
 * reported as `REFUSED` with exit 0; any other failure is an error.
 *
 * Events are appended to the shared log file: `publish-attempting`,
 * `publish-committed:<revision|REFUSED>`, `publish-returned:<revision|REFUSED>`,
 * `publish-released`.
 */

/** @var list<string> $argv */
$argv = $_SERVER['argv'] ?? [];

/** Appends one event line to the shared log. */
function publishWorkerEvent(string $logPath, string $line): void
{
    file_put_contents($logPath, $line . "\n", FILE_APPEND);
}

$arguments = array_pad($argv, 7, '');
[$script, $configPath, $expectedRevision, $mode, $logPath, $markerPath, $releasePath] = $arguments;

if (
    $configPath === ''
    || $expectedRevision === ''
    || !\in_array($mode, ['publish', 'hold-publish'], true)
    || $logPath === ''
    || $markerPath === ''
    || ($mode === 'hold-publish' && $releasePath === '')
) {
    fwrite(STDERR, "publish worker arguments missing or invalid\n");
    exit(2);
}

try {
    $kernel = Kernel::boot($configPath);
    $storage = $kernel->storage;

    /** @var string $outcome */
    $outcome = '';
    $publish = static function () use ($storage, $expectedRevision, &$outcome): void {
        try {
            $published = $storage->publishDraft((int) $expectedRevision);
            $outcome = (string) $published['revision'];
        } catch (DanglingMediaReferenceException) {
            $outcome = 'REFUSED';
        }
    };

    if ($mode === 'publish') {
        file_put_contents($markerPath, '1');
        publishWorkerEvent($logPath, 'publish-attempting');
        $publish();
        publishWorkerEvent($logPath, 'publish-returned:' . $outcome);
        fwrite(STDOUT, ($outcome === 'REFUSED' ? 'REFUSED' : 'PUBLISHED rev=' . $outcome) . "\n");
        exit(0);
    }

    // hold-publish: the boundary is held shared across the whole publish and
    // kept held afterwards until the caller releases it.
    $boundary = new MediaContentLock($kernel->config->lockDir);
    $boundary->withShared(
        static function () use ($publish, $logPath, $markerPath, $releasePath, &$outcome): void {
            file_put_contents($markerPath, '1');
            publishWorkerEvent($logPath, 'publish-inside');
            $publish();
            publishWorkerEvent($logPath, 'publish-committed:' . $outcome);

            $deadline = microtime(true) + 30.0;
            while (!is_file($releasePath)) {
                if (microtime(true) > $deadline) {
                    throw new \RuntimeException('publish worker timed out waiting for its release file.');
                }
                usleep(10_000);
            }
        },
    );
    publishWorkerEvent($logPath, 'publish-released');
    fwrite(STDOUT, ($outcome === 'REFUSED' ? 'REFUSED' : 'PUBLISHED') . "-HOLD\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
