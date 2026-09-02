<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

use Eszter\Media\UploadTransport;

/**
 * The upload transport, without a web server.
 *
 * `is_uploaded_file()` answers only for paths PHP wrote while parsing the current
 * request, so it can never be true inside PHPUnit. This double keeps its own
 * register of "files this request uploaded", which is the same *shape* of
 * guarantee: a path that was not registered is refused exactly as the real one
 * would refuse a path PHP did not write.
 *
 * That is why {@see registered()} exists and why the suite uses it rather than
 * simply accepting everything — the check that a `$_FILES` entry pointing at
 * `/etc/passwd` is refused is one of the checks worth having, and a double that
 * said yes to everything would make it untestable.
 */
final class FakeUploadTransport implements UploadTransport
{
    /** @var array<string, true> */
    private array $registered = [];

    /** Writes $contents to a temp path and registers it as this request's upload. */
    public function stage(string $directory, string $contents): string
    {
        $path = $directory . \DIRECTORY_SEPARATOR . 'upload-' . bin2hex(random_bytes(8));
        file_put_contents($path, $contents);
        // PHP's own upload temp files are mode 0600; the staged double mirrors
        // that so a rename-based move observes the same birth mode production
        // does (ESZ-103).
        chmod($path, 0o600);
        $this->registered[$path] = true;

        return $path;
    }

    public function isUploadedFile(string $path): bool
    {
        return isset($this->registered[$path]);
    }

    public function moveUploadedFile(string $path, string $destination): bool
    {
        if (!isset($this->registered[$path])) {
            return false;
        }

        // `rename()` rather than a copy, matching what move_uploaded_file() does
        // when both paths are on one filesystem — so a test observes the same
        // "the temp file is gone afterwards" behaviour production does.
        if (!@rename($path, $destination)) {
            return false;
        }

        unset($this->registered[$path]);

        return true;
    }
}
