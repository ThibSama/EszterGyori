<?php

declare(strict_types=1);

use Eszter\Kernel;
use Eszter\Media\MediaReferences;
use Eszter\Media\MediaReferencedException;
use Eszter\Storage\ContentStorage;
use Eszter\Storage\MediaContentLock;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * ESZ-100 worker: deletes one media asset through the real MediaLibrary.
 *
 * Invoked as an independent process by MediaDeleteConcurrencyTest so the delete
 * contends for the media/content boundary through real flock(2), exactly like a
 * `DELETE /api/admin/media` request. The reference predicate mirrors the admin
 * endpoint: an asset is deletable only when neither the authoritative draft nor
 * the published document points at it, and an unreadable document refuses the
 * delete rather than allowing it.
 *
 * Modes:
 *
 *   delete       deleteAsset(id) then exit; the marker file is created just
 *                before the delete is attempted.
 *   hold-delete  the boundary is first taken exclusively and held until the
 *                release file appears, so the caller can prove a save waiting
 *                on the boundary cannot commit across the deletion.
 *
 * Events are appended to the shared log file: `delete-inside`, `delete-done`,
 * `delete-released`, `delete-returned:<DELETED|REFUSED>`.
 */

/** @var list<string> $argv */
$argv = $_SERVER['argv'] ?? [];

/** Appends one event line to the shared log. */
function deleteWorkerEvent(string $logPath, string $line): void
{
    file_put_contents($logPath, $line . "\n", FILE_APPEND);
}

/**
 * The endpoint's reference rule, reproduced so the worker exercises the same
 * decision a real delete request would.
 *
 * @return callable(string): bool
 */
function deleteWorkerPredicate(ContentStorage $storage): callable
{
    return static function (string $publicPath) use ($storage): bool {
        foreach ([$storage->readDraft(), $storage->readPublished()] as $envelope) {
            /** @var mixed $content */
            $content = $envelope['content'] ?? null;

            if (!\is_array($content)) {
                throw new \RuntimeException('A stored envelope carries no content object to scan.');
            }

            if (MediaReferences::isReferenced($content, $publicPath)) {
                return true;
            }
        }

        return false;
    };
}

$arguments = array_pad($argv, 7, '');
[$script, $configPath, $assetId, $mode, $logPath, $markerPath, $releasePath] = $arguments;

if (
    $configPath === ''
    || $assetId === ''
    || !\in_array($mode, ['delete', 'hold-delete'], true)
    || $logPath === ''
    || $markerPath === ''
) {
    fwrite(STDERR, "delete worker arguments missing or invalid\n");
    exit(2);
}

try {
    $kernel = Kernel::boot($configPath);
    $library = $kernel->mediaLibrary;
    $predicate = deleteWorkerPredicate($kernel->storage);

    /** @var string $outcome */
    $outcome = '';
    $delete = static function () use ($library, $predicate, $assetId, &$outcome): void {
        try {
            $library->deleteAsset($assetId, $predicate);
            $outcome = 'DELETED';
        } catch (MediaReferencedException) {
            $outcome = 'REFUSED';
        }
    };

    if ($mode === 'delete') {
        file_put_contents($markerPath, '1');
        deleteWorkerEvent($logPath, 'delete-attempting');
        $delete();
        deleteWorkerEvent($logPath, 'delete-returned:' . $outcome);
        fwrite(STDOUT, $outcome . "\n");
        exit(0);
    }

    // hold-delete: the boundary is taken exclusively across the whole delete
    // and held afterwards until the caller releases it, so a save attempting in
    // that window is provably blocked until the deletion is fully committed.
    $boundary = new MediaContentLock($kernel->config->lockDir);
    $boundary->withExclusive(
        static function () use (
            $delete,
            $logPath,
            $markerPath,
            $releasePath,
            &$outcome,
        ): void {
            file_put_contents($markerPath, '1');
            deleteWorkerEvent($logPath, 'delete-inside');
            $delete();
            deleteWorkerEvent($logPath, 'delete-done:' . $outcome);

            $deadline = microtime(true) + 30.0;
            while (!is_file($releasePath)) {
                if (microtime(true) > $deadline) {
                    throw new \RuntimeException('delete worker timed out waiting for its release file.');
                }
                usleep(10_000);
            }
        },
    );
    deleteWorkerEvent($logPath, 'delete-released');
    fwrite(STDOUT, $outcome . "-HOLD\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
