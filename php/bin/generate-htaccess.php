#!/usr/bin/env php
<?php

/**
 * Writes the document-root `.htaccess` files from the routing table.
 *
 * The routing rules live in `src/Deploy/DocumentRootRouting.php`; this only
 * renders them. `HtaccessTest` regenerates and compares against what is
 * committed, so running this is how you apply a routing change, and forgetting to
 * run it is a failing gate rather than a production surprise.
 */

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use Eszter\Deploy\HtaccessRenderer;

$publicDir = \dirname(__DIR__) . '/public';
$written = 0;

foreach (HtaccessRenderer::files() as $relativePath => $contents) {
    $path = $publicDir . '/' . $relativePath;
    $directory = \dirname($path);

    if (!is_dir($directory) && !mkdir($directory, 0o755, true) && !is_dir($directory)) {
        fwrite(STDERR, "Could not create {$directory}\n");
        exit(1);
    }

    if (file_put_contents($path, $contents) === false) {
        fwrite(STDERR, "Could not write {$path}\n");
        exit(1);
    }

    ++$written;
    echo "wrote public/{$relativePath}\n";
}

echo "Generated {$written} .htaccess file(s) from the routing table.\n";
