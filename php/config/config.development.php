<?php

declare(strict_types=1);

/**
 * Project-owned full-stack development configuration.
 *
 * The values below are deliberately development-only defaults matching
 * `compose.dev.yml`. They are not production secrets. Every value may be
 * overridden from the shell for a developer who already uses the default port or
 * database name; production continues to use `config/config.php` and the
 * file-based fail-fast rules documented for Hetzner.
 */

$databaseName = getenv('ESZTER_DEV_DB_NAME') ?: 'eszter_dev';
$databaseUsername = getenv('ESZTER_DEV_DB_USERNAME') ?: 'eszter_dev';
$databasePassword = getenv('ESZTER_DEV_DB_PASSWORD') ?: 'eszter_dev_only';
$databasePort = getenv('ESZTER_DEV_DB_PORT') ?: '3307';

if (preg_match('/^\d{1,5}$/', $databasePort) !== 1 || (int) $databasePort > 65535) {
    throw new RuntimeException('ESZTER_DEV_DB_PORT must be an integer between 1 and 65535.');
}
if (preg_match('/^[A-Za-z0-9_-]{1,64}$/', $databaseName) !== 1) {
    throw new RuntimeException('ESZTER_DEV_DB_NAME contains unsupported characters.');
}

return [
    'environment' => 'development',
    'logLevel' => 'debug',
    'paths' => [
        'content' => '../data/content',
        'tmp' => '../var/tmp',
        'locks' => '../data/locks',
        'log' => '../var/log',
        'contracts' => '../../contracts/generated',
        'mediaOriginals' => '../data/media-originals',
        'public' => '../../front/out',
    ],
    'database' => [
        'dsn' => sprintf(
            'mysql:host=127.0.0.1;port=%d;dbname=%s;charset=utf8mb4',
            (int) $databasePort,
            $databaseName,
        ),
        'username' => $databaseUsername,
        'password' => $databasePassword,
        'connectTimeoutSeconds' => 5,
    ],
    'session' => [
        // SessionCookie deliberately removes the __Host- prefix when Secure is
        // disabled, so plain-HTTP development cannot mint a cookie production
        // would accept under the production name.
        'cookieSecure' => false,
        'idleTimeoutSeconds' => 3600,
        'absoluteTimeoutSeconds' => 43200,
    ],
    // SMTP is intentionally not configured locally. Booking still enqueues its
    // durable e-mail jobs; only external delivery remains a production/live gate.
];
