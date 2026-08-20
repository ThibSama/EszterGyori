<?php

declare(strict_types=1);

namespace Eszter\Deploy;

/**
 * How the document root resolves a request (ESZ-022).
 *
 * `docs/hetzner-target-architecture.md` §12 says the *order* of these rules is
 * the specification rather than an implementation detail, and this class is that
 * sentence made executable. It exists because `.htaccess` is otherwise the one
 * load-bearing part of the system with no tests: it cannot be unit-tested, it
 * only misbehaves on the host, and its failures are the confusing kind — an API
 * 404 that arrives as HTML, an admin deep link that 404s on refresh, a redirect
 * loop that appears in production and nowhere else.
 *
 * So the rules are declared here, the `.htaccess` is *generated* from them, and a
 * test asserts the committed file still matches. What the suite exercises through
 * {@see resolve()} is therefore the same table Apache is given, not a second
 * description of it that can drift.
 *
 * This is a model of `mod_rewrite`, not an implementation of it. It captures what
 * the rules are for — precedence and the target each path lands on — and
 * deliberately not Apache's full matching semantics.
 */
final class DocumentRootRouting
{
    /** The PHP front controller: the public page and the whole JSON API. */
    public const FRONT_CONTROLLER = 'php:api/index.php';

    /** A file that exists on disk, served by Apache with no rewriting. */
    public const STATIC_FILE = 'static:file';

    /** An exported admin page, or the shell when the deep link has no file. */
    public const ADMIN_SHELL = 'static:admin-shell';

    /** A reserved path that must resolve to nothing until it is built. */
    public const RESERVED = 'static:404-reserved';

    /** The exported 404 document. */
    public const NOT_FOUND = 'static:404';

    /**
     * Paths reserved for work that does not exist yet.
     *
     * `/reservation` is Package 2.3's. It is listed *now*, before there is
     * anything behind it, because the alternative is that it silently becomes
     * something else: with no rule of its own it would fall into the catch-all
     * today and — the moment anyone widens the admin or public rule — into one of
     * those instead. Naming it pins it to a deterministic 404 and makes the
     * booking flow a change to this line rather than a discovery that the path was
     * already taken.
     *
     * It is deliberately not a redirect to `/#contact`. Inventing product
     * behaviour for a feature that has not been designed is worse than an honest
     * "not here".
     */
    public const RESERVED_PATHS = ['/reservation'];

    /**
     * The ordered rule table.
     *
     * @return list<array{id: string, description: string, target: string}>
     */
    public static function rules(): array
    {
        return [
            [
                'id' => 'api',
                'description' =>
                    'Everything under /api/ goes to the front controller, first and unconditionally, '
                    . 'so no later catch-all can turn a JSON 404 into an HTML page.',
                'target' => self::FRONT_CONTROLLER,
            ],
            [
                'id' => 'existing-file',
                'description' =>
                    'A request that names a real file or directory is served as-is: hashed _next/ '
                    . 'assets, media, icons, robots.txt.',
                'target' => self::STATIC_FILE,
            ],
            [
                'id' => 'reserved',
                'description' =>
                    'Paths reserved for unbuilt features resolve to the 404 document rather than '
                    . 'falling into a later rule.',
                'target' => self::RESERVED,
            ],
            [
                'id' => 'admin-page',
                'description' =>
                    'An admin path with an exported page (/admin/login -> admin/login.html) serves '
                    . 'that page, so a refresh or a direct link lands on the right screen.',
                'target' => self::ADMIN_SHELL,
            ],
            [
                'id' => 'admin-deep-link',
                'description' =>
                    'Any other /admin path serves the admin shell, so client-side routes survive a '
                    . 'refresh instead of 404-ing.',
                'target' => self::ADMIN_SHELL,
            ],
            [
                'id' => 'public-page',
                'description' =>
                    'The site root is served by PHP, which injects the published content into the '
                    . 'exported index.html before sending it (ESZ-021).',
                'target' => self::FRONT_CONTROLLER,
            ],
            [
                'id' => 'not-found',
                'description' =>
                    'Anything else is the exported 404 document. Unknown /api paths never reach '
                    . 'here: rule 1 already claimed them, and they answer the frozen JSON envelope.',
                'target' => self::NOT_FOUND,
            ],
        ];
    }

    /**
     * Resolves one path against the table.
     *
     * @param string $path The request path, without query string.
     * @param callable(string): bool $fileExists Whether a document-root-relative
     *        path exists. Injected so the suite can describe an export without
     *        materialising one.
     * @return array{rule: string, target: string, file: string|null}
     */
    public static function resolve(string $path, callable $fileExists): array
    {
        if ($path === '/api' || str_starts_with($path, '/api/')) {
            return self::outcome('api', self::FRONT_CONTROLLER, null);
        }

        $relative = ltrim($path, '/');

        if ($relative !== '' && $fileExists($relative)) {
            return self::outcome('existing-file', self::STATIC_FILE, $relative);
        }

        // Checked before the admin rules, not after: `/reservation` must be
        // unreachable through any other rule, and order is the only thing that
        // guarantees it.
        foreach (self::RESERVED_PATHS as $reserved) {
            if ($path === $reserved || str_starts_with($path, $reserved . '/')) {
                return self::outcome('reserved', self::RESERVED, '404.html');
            }
        }

        if ($path === '/admin' || str_starts_with($path, '/admin/')) {
            $candidate = $relative . '.html';

            if ($fileExists($candidate)) {
                return self::outcome('admin-page', self::ADMIN_SHELL, $candidate);
            }

            return self::outcome('admin-deep-link', self::ADMIN_SHELL, 'admin.html');
        }

        if ($path === '/') {
            return self::outcome('public-page', self::FRONT_CONTROLLER, null);
        }

        return self::outcome('not-found', self::NOT_FOUND, '404.html');
    }

    /**
     * @return array{rule: string, target: string, file: string|null}
     */
    private static function outcome(string $rule, string $target, ?string $file): array
    {
        return ['rule' => $rule, 'target' => $target, 'file' => $file];
    }
}
