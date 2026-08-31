<?php

/**
 * Non-secret configuration for the repository-local PHP development server.
 *
 * Production continues to use an untracked config/config.php outside the web
 * root. This file deliberately has no database or SMTP block: the public site,
 * public content and health routes need neither, while authenticated/booking
 * routes remain unavailable until a developer explicitly supplies a fuller
 * configuration through ESZTER_CONFIG.
 */

declare(strict_types=1);

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
    'session' => [
        'idleTimeoutMinutes' => 60,
        'absoluteLifetimeMinutes' => 720,
        'cookieSecure' => false,
    ],
];
