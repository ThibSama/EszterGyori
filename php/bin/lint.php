#!/usr/bin/env php
<?php

/**
 * `php -l` over every PHP source file — the `php:lint` gate.
 *
 * A parse error in a file no test happens to load is invisible to PHPUnit and
 * fatal in production, so the whole tree is walked rather than the autoloaded
 * part of it.
 */

declare(strict_types=1);

$root = \dirname(__DIR__);
$directories = ['src', 'tests', 'bin', 'config', 'public'];

$failures = [];
$checked = 0;

foreach ($directories as $directory) {
    $path = $root . '/' . $directory;
    if (!is_dir($path)) {
        continue;
    }

    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
    );

    foreach ($files as $file) {
        /** @var SplFileInfo $file */
        if ($file->getExtension() !== 'php') {
            continue;
        }

        $checked++;
        exec(
            \sprintf('%s -l -n %s 2>&1', escapeshellarg(PHP_BINARY), escapeshellarg($file->getPathname())),
            $output,
            $status,
        );

        if ($status !== 0) {
            $failures[] = implode("\n", $output);
        }

        $output = [];
    }
}

if ($failures !== []) {
    fwrite(STDERR, implode("\n", $failures) . "\n");
    fwrite(STDERR, \sprintf("php -l: %d file(s) failed to parse.\n", \count($failures)));
    exit(1);
}

fwrite(STDOUT, \sprintf("php -l: %d file(s) parsed cleanly.\n", $checked));
