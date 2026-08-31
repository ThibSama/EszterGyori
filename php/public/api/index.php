<?php

/**
 * The one PHP file under the document root.
 *
 * `docs/hetzner-target-architecture.md` §3, rule 1: a single entry point that
 * bootstraps from a sibling of the document root. Nothing else executable is
 * web-reachable, so there is no second way into the application to secure.
 *
 * Two layouts are supported, deliberately without configuration:
 *
 *   repository   php/public/api/index.php  →  app root php/, config php/config/
 *   Hetzner      public_html/api/index.php →  app root $HOME/app/, config $HOME/config/
 *
 * Deploying is therefore a copy, not a rewrite, and what runs in production is
 * the file the tests exercised.
 */

declare(strict_types=1);

$appRootCandidates = [
    \dirname(__DIR__, 2),           // repository: php/
    \dirname(__DIR__, 2) . '/app',  // Hetzner: $HOME/app/
];

$appRoot = null;
foreach ($appRootCandidates as $candidate) {
    if (is_file($candidate . '/vendor/autoload.php')) {
        $appRoot = $candidate;
        break;
    }
}

if ($appRoot === null) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    error_log('[eszter] no application root with vendor/autoload.php was found');
    echo '{"error":{"code":"INVALID_CONFIGURATION",'
        . '"message":"La configuration du serveur est invalide.",'
        . '"requestId":"req_bootstrap"}}';

    return;
}

require $appRoot . '/vendor/autoload.php';

$configCandidates = [
    getenv('ESZTER_CONFIG') ?: null,
    $appRoot . '/config/config.php',
    \dirname($appRoot) . '/config/config.php',
];

$configPath = $appRoot . '/config/config.php';
foreach ($configCandidates as $candidate) {
    if (\is_string($candidate) && is_file($candidate)) {
        $configPath = $candidate;
        break;
    }
}

Eszter\Kernel::run($configPath);
