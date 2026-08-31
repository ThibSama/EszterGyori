<?php

/**
 * Router adapter for PHP's built-in development server.
 *
 * Apache applies public/.htaccess in production. PHP's built-in server does not,
 * so this adapter executes the same DocumentRootRouting table and delegates the
 * PHP targets to the production front controller. Existing export files are left
 * to the built-in server; rewritten export pages are emitted here.
 */

declare(strict_types=1);

use Eszter\Deploy\DocumentRootRouting;

$repositoryRoot = \dirname(__DIR__, 2);
$exportRoot = $repositoryRoot . '/front/out';
$autoload = $repositoryRoot . '/php/vendor/autoload.php';

if (!is_file($autoload)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Composer dependencies are missing. Run: composer install --working-dir=php\n";

    return true;
}

require $autoload;

$requestUri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url(is_string($requestUri) ? $requestUri : '/', PHP_URL_PATH);
$path = is_string($path) ? rawurldecode($path) : '/';

if (
    str_contains($path, "\0")
    || str_contains($path, '\\')
    || preg_match('#(?:^|/)\.\.?(/|$)#', $path) === 1
) {
    $path = '/__invalid_path__';
}

$route = DocumentRootRouting::resolve(
    $path,
    static fn (string $relative): bool => is_file($exportRoot . '/' . $relative)
        || is_dir($exportRoot . '/' . $relative),
);

if ($route['target'] === DocumentRootRouting::FRONT_CONTROLLER) {
    require __DIR__ . '/api/index.php';

    return true;
}

if ($route['target'] === DocumentRootRouting::CANONICAL_REDIRECT) {
    $query = $_SERVER['QUERY_STRING'] ?? '';
    $suffix = is_string($query) && $query !== '' ? '?' . $query : '';
    header('Location: /' . $route['file'] . $suffix, true, 301);

    return true;
}

if ($route['rule'] === 'existing-file') {
    // The server was started with front/out as its document root.
    return false;
}

$relativeFile = $route['file'];
if (!is_string($relativeFile) || !is_file($exportRoot . '/' . $relativeFile)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not Found\n";

    return true;
}

if ($route['target'] === DocumentRootRouting::NOT_FOUND) {
    http_response_code(404);
}

$extension = strtolower(pathinfo($relativeFile, PATHINFO_EXTENSION));
$contentTypes = [
    'css' => 'text/css; charset=utf-8',
    'html' => 'text/html; charset=utf-8',
    'ico' => 'image/x-icon',
    'js' => 'text/javascript; charset=utf-8',
    'json' => 'application/json; charset=utf-8',
    'png' => 'image/png',
    'svg' => 'image/svg+xml',
    'txt' => 'text/plain; charset=utf-8',
    'webmanifest' => 'application/manifest+json; charset=utf-8',
    'webp' => 'image/webp',
    'woff' => 'font/woff',
    'woff2' => 'font/woff2',
];

header('Content-Type: ' . ($contentTypes[$extension] ?? 'application/octet-stream'));
header('Content-Length: ' . (string) filesize($exportRoot . '/' . $relativeFile));

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
    readfile($exportRoot . '/' . $relativeFile);
}

return true;
