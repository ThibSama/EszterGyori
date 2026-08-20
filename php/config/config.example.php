<?php

/**
 * Copy to `config/config.php` and adjust. Never commit the copy — `.gitignore`
 * excludes it, and the file must be mode 0600, owned by the application user.
 *
 * Configuration is read from a file, not from environment variables: shared
 * hosting gives no reliable way to set them per process
 * (`docs/hetzner-target-architecture.md` §9).
 *
 * Relative paths resolve against this file's directory.
 */

declare(strict_types=1);

return [
    // development | test | production
    'environment' => 'production',

    // debug | info | warn | error
    'logLevel' => 'info',

    'paths' => [
        // draft.json and published.json. Must NOT be web-reachable.
        'content' => '../data/content',

        // Atomic-write staging. MUST be on the same filesystem as `content`,
        // otherwise rename() is not atomic and the boot check will refuse to start.
        'tmp' => '../var/tmp',

        // Advisory flock() files.
        'locks' => '../data/locks',

        // Application log directory.
        'log' => '../var/log',

        // The committed `contracts/generated/` artifacts, copied at deploy time.
        // This backend derives its entire schema from them; see
        // `docs/contract-freeze.md`, "What a PHP implementation must do".
        'contracts' => '../app/contracts',

        // The document root: the Next static export, copied at deploy time.
        // `/` is served by reading `index.html` from here and injecting the
        // published content into it (`docs/hetzner-target-architecture.md` §5),
        // so this is the only path that is web-reachable by design.
        'public' => '../public_html',
    ],
];
