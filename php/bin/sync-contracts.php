#!/usr/bin/env php
<?php

/**
 * Copies `contracts/generated/` to the directory this backend reads it from.
 *
 * The PHP runtime must not depend on Node, and it must not depend on the
 * TypeScript workspace being present either — on Hetzner it will not be. So the
 * generated artifacts are copied next to the application at deploy time and read
 * from there. This script is that copy, made verifiable: every file is checked
 * against its `manifest.json` digest at the source *and* re-checked at the
 * destination, so a truncated transfer fails here instead of at the first request.
 *
 * Usage: php bin/sync-contracts.php [--source=DIR] [--target=DIR] [--check]
 *
 *   --check  compare only; exit 1 if the target is missing or stale.
 */

declare(strict_types=1);

require \dirname(__DIR__) . '/vendor/autoload.php';

use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;

$options = getopt('', ['source::', 'target::', 'check']);

$source = \is_string($options['source'] ?? null)
    ? $options['source']
    : \dirname(__DIR__, 2) . '/contracts/generated';

$target = \is_string($options['target'] ?? null)
    ? $options['target']
    : \dirname(__DIR__) . '/contracts';

$checkOnly = \array_key_exists('check', $options);

try {
    $artifacts = new ContractArtifacts($source);
    $files = [ContractArtifacts::MANIFEST, ...$artifacts->verifyAll()];
} catch (ContractArtifactException $exception) {
    fwrite(STDERR, "source artifacts are not usable: {$exception->getMessage()}\n");
    exit(1);
}

$stale = [];

foreach ($files as $file) {
    $from = $source . '/' . $file;
    $to = $target . '/' . $file;

    if (!is_file($to) || hash_file('sha256', $to) !== hash_file('sha256', $from)) {
        $stale[] = $file;
    }
}

if ($checkOnly) {
    if ($stale !== []) {
        fwrite(STDERR, "stale or missing in {$target}: " . implode(', ', $stale) . "\n");
        fwrite(STDERR, "run: php bin/sync-contracts.php\n");
        exit(1);
    }

    fwrite(STDOUT, \sprintf("contracts: %d artifact(s) in sync at %s\n", \count($files), $target));
    exit(0);
}

if (!is_dir($target) && !mkdir($target, 0o750, true) && !is_dir($target)) {
    fwrite(STDERR, "could not create {$target}\n");
    exit(1);
}

foreach ($files as $file) {
    if (!copy($source . '/' . $file, $target . '/' . $file)) {
        fwrite(STDERR, "could not copy {$file}\n");
        exit(1);
    }
}

// Re-verify at the destination: a copy that silently truncated would otherwise
// only be discovered by a validator that quietly accepts too much.
try {
    (new ContractArtifacts($target))->verifyAll();
} catch (ContractArtifactException $exception) {
    fwrite(STDERR, "copied artifacts failed verification: {$exception->getMessage()}\n");
    exit(1);
}

fwrite(STDOUT, \sprintf("contracts: %d artifact(s) copied to %s\n", \count($files), $target));
