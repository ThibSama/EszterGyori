#!/usr/bin/env php
<?php

/**
 * The `php:static-analysis` gate: PHPStan over production code and tests at
 * their pinned levels, then PSR-12 over everything.
 *
 * One entry point so the validation runner has one command to call and cannot
 * accidentally run half of it.
 */

declare(strict_types=1);

$root = \dirname(__DIR__);

$phpstan = static fn (string $config): array => [
    $root . '/vendor/bin/phpstan',
    'analyse',
    '--no-progress',
    '-c',
    $root . '/' . $config,
];

$steps = [
    'phpstan (src, bin) — level max' => $phpstan('phpstan.neon.dist'),
    'phpstan (tests) — level 6' => $phpstan('phpstan.tests.neon.dist'),
    'phpcs — PSR-12' => [$root . '/vendor/bin/phpcs', '--standard=' . $root . '/phpcs.xml.dist'],
];

$failed = [];

foreach ($steps as $label => $command) {
    fwrite(STDOUT, "── {$label}\n");

    $process = proc_open(
        array_map('strval', $command),
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        $root,
    );

    if (!\is_resource($process)) {
        fwrite(STDERR, "could not start: {$label}\n");
        exit(2);
    }

    $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);

    if (proc_close($process) !== 0) {
        $failed[] = $label;
        fwrite(STDERR, $output . "\n");
    }
}

if ($failed !== []) {
    fwrite(STDERR, 'static analysis failed: ' . implode(', ', $failed) . "\n");
    exit(1);
}

fwrite(STDOUT, "static analysis: all steps passed.\n");
