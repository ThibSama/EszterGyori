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

        // Uploaded media originals (ESZ-036). MUST NOT be web-reachable, and
        // Intake is a child of this directory so finalising an original with
        // rename() cannot cross a filesystem. Nothing ever serves a file from
        // here: it exists so a derivative can be rebuilt without asking the
        // editor to upload again.
        'mediaOriginals' => '../data/media-originals',

        // The document root: the Next static export, copied at deploy time.
        // `/` is served by reading `index.html` from here and injecting the
        // published content into it (`docs/hetzner-target-architecture.md` §5),
        // so this is the only path that is web-reachable by design.
        'public' => '../public_html',
    ],

    // ── Operational database (ESZ-023) ───────────────────────────────────────
    //
    // MySQL owns operational state only: admin accounts and sessions. Editorial
    // content stays in data/content/*.json and never enters SQL
    // (`docs/hetzner-target-architecture.md` §4 and §8).
    //
    // Required in production. Outside production it may be omitted entirely, and
    // the public read-only surface still works — it touches no database.
    //
    // Deployed command:
    // /usr/bin/php /usr/home/<FTP_LOGIN>/eszter/app/bin/migrate.php
    //     --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php
    'database' => [
        // The target host runs MySQL. utf8mb4 is not optional: the content
        // pipeline guarantees NFC UTF-8 end to end and the database must not be
        // the component that breaks it.
        'dsn' => 'mysql:host=localhost;port=3306;dbname=eszter;charset=utf8mb4',
        'username' => 'eszter',

        // PLACEHOLDER. Booting in production with this value, or with an empty
        // one, fails fast rather than connecting to something guessable.
        'password' => 'CHANGE_ME',

        // Seconds to wait for a connection before failing the request.
        'connectTimeoutSeconds' => 5,
    ],

    // ── Admin sessions (ESZ-025) ─────────────────────────────────────────────
    //
    // The cookie's name and its HttpOnly/SameSite/Path attributes are NOT here.
    // They are frozen in contracts/generated/http-contract.json under `auth`, so
    // that no configuration file can quietly relax them. Only the timings and the
    // one environment-dependent flag are settings.
    'session' => [
        // Inactivity after which the session stops being accepted. Enforced
        // against the server-side record, never against the cookie's Max-Age.
        'idleTimeoutMinutes' => 60,

        // Ceiling on total life regardless of activity, so a continuously-used
        // stolen session still expires.
        'absoluteLifetimeMinutes' => 720,

        // Must be true in production; booting with false there fails fast. Set it
        // to false only on a developer's plain-HTTP localhost.
        'cookieSecure' => true,
    ],

    // ── Booking e-mail / SMTP (ESZ-073/074) ────────────────────────────────
    // Required in production. Values are deployment-owned: no Hetzner SMTP
    // host, port or credential is assumed by the application.
    'notifications' => [
        'email' => [
            'host' => 'smtp.example.invalid',
            'port' => 587,
            // starttls | smtps — the only modes production accepts: mandatory
            // STARTTLS (never an opportunistic downgrade) or implicit TLS from
            // the first byte. `none` (plaintext) is a development/test setting
            // for deliberately controlled plaintext relays only; production
            // refuses it during configuration/preflight.
            'encryption' => 'starttls',
            'authenticationRequired' => true,
            'username' => 'CHANGE_ME',
            // Secret. Never logged or copied into an error message.
            'password' => 'CHANGE_ME',
            'senderAddress' => 'bonjour@example.invalid',
            'senderName' => 'Eszter Gyori',
            // Applies to the SMTP socket connection and reads/writes; bounded
            // to 1–30 seconds so one provider cannot consume a whole cron tick.
            'timeoutSeconds' => 10,
            // Canonical customer-facing copy included in every template.
            'customerContact' => 'Pour toute question, répondez à cet e-mail.',
            'customerInstructions' => 'Merci de prévenir dès que possible en cas d’empêchement.',
        ],
    ],
];
