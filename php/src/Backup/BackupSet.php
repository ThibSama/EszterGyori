<?php

declare(strict_types=1);

namespace Eszter\Backup;

/**
 * What a backup contains, and — just as importantly — what it does not (ESZ-083).
 *
 * The set is declared here as data rather than discovered by walking the
 * deployment. Walking is how a backup tool ends up carrying `config/config.php`
 * the first time someone reorganises the tree, and a secret in a backup is a
 * secret in every copy of that backup, in every place it was ever downloaded to.
 * A declared set omits a *new* thing until someone adds it, which is visible in a
 * diff; a discovered set includes it until someone remembers to exclude it, which
 * is not.
 *
 * ## The three parts, and why each is durable
 *
 * **The database** holds bookings, their history, availability, services, admin
 * accounts and the notification queue. None of it can be recomputed from
 * anything.
 *
 * **The content JSON** — `draft.json`, `published.json` and `media-library.json`
 * — is the editorial state. It is deliberately not in SQL
 * (`hetzner-target-architecture.md` §4), so a database backup alone would restore
 * a site with no words on it.
 *
 * **Media originals and derivatives**, both. The original exists so a derivative
 * can be rebuilt without asking the editor to upload again, and it is the only
 * copy of what they actually supplied. The derivative is included as well rather
 * than rebuilt on restore, because a rebuild runs through whatever GD the
 * restoring host happens to have: the bytes the site serves would change, every
 * cached copy and every hash of them would be wrong, and a restore is the last
 * moment anyone wants to discover their images were re-encoded.
 *
 * ## What is excluded, and why each exclusion is deliberate
 *
 * - **`config/config.php`** — the database password, the SMTP password. Restoring
 *   it would also restore credentials that may since have been rotated. The
 *   operator supplies configuration; the backup never carries it.
 * - **`admin_sessions`** — live credentials in table form. A restore that brought
 *   them back would resurrect sessions that had been deliberately ended, and the
 *   correct state after any restore is "everybody signs in again".
 * - **`rate_limit_buckets`** — ephemeral abuse counters with no meaning outside
 *   the minutes they were written in, and the one table that is derived from
 *   visitors rather than from the site.
 * - **`booking_resource_locks`** — a serialization row whose only content is its
 *   own existence; the migrations recreate it.
 * - **`var/log`** — customer names, addresses and phone numbers appear in booking
 *   diagnostics. Logs have their own retention and do not belong in a file that
 *   gets copied to laptops.
 * - **`var/tmp`, `data/locks`, `.intake/`, `.staging-*`** — in-flight state by
 *   definition. Every one of them is a file that exists only between two moments
 *   of a write, and restoring one means restoring a half-finished operation.
 * - **`app/`, `vendor/`, `public_html/` except `media/`** — code and build output.
 *   They come from `dist/eszter-production.tar.gz`, which is reproducible from the
 *   repository; putting them here would make every backup ten times its useful
 *   size and would let a restore quietly downgrade the application.
 */
final class BackupSet
{
    public const FORMAT_VERSION = 1;

    public const MANIFEST_FILE = 'BACKUP-MANIFEST.json';
    public const DATABASE_FILE = 'database/dump.sql';
    public const CONTENT_PREFIX = 'content/';
    public const ORIGINALS_PREFIX = 'media-originals/';
    public const DERIVATIVES_PREFIX = 'media/';

    /**
     * The editorial files, by name. Missing ones are recorded as absent rather
     * than invented: a deployment that has never uploaded an image has no
     * `media-library.json`, and seeding one during a backup would make the backup
     * a writer.
     */
    public const CONTENT_FILES = ['draft.json', 'published.json', 'media-library.json'];

    /**
     * The tables a backup carries, in dependency order.
     *
     * Ordered so a restore can insert them one after another with foreign keys
     * enforced the whole way — a parent is always written before anything that
     * references it. The restore does not disable key checks, deliberately: a set
     * that only loads with the checks off is a set with a broken reference in it,
     * and that is worth finding out during the restore rather than afterwards.
     */
    public const TABLES = [
        'schema_migrations',
        'admin_accounts',
        'booking_services',
        'system_settings',
        'availability_rules',
        'availability_exceptions',
        'availability_exception_windows',
        'bookings',
        'booking_history',
        'notification_jobs',
    ];

    /**
     * Tables that exist and are deliberately left out. Named rather than merely
     * absent, so that a new table is a decision someone has to make instead of an
     * omission nobody notices.
     */
    public const EXCLUDED_TABLES = [
        'admin_sessions' => 'Live session credentials; every restore should require signing in again.',
        'rate_limit_buckets' => 'Ephemeral abuse counters derived from visitors, meaningless once restored.',
        'booking_resource_locks' => 'A serialization row whose only content is its existence; migrations recreate it.',
    ];

    /**
     * A ceiling on what one archive may hold, checked while it is assembled.
     *
     * The archive is built in memory — see {@see TarArchive::read()} — which is
     * right for a five-page site's images and wrong for a set that has somehow
     * grown into gigabytes. Rather than let that discovery happen as an
     * out-of-memory fatal partway through writing a file the operator will
     * believe is a backup, the size is bounded and the refusal says so.
     */
    public const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

    /** Files inside the media directories that are never part of a backup. */
    public static function isTransient(string $fileName): bool
    {
        return str_starts_with($fileName, '.')
            || str_starts_with($fileName, '.staging-')
            || str_ends_with($fileName, '.tmp');
    }
}
