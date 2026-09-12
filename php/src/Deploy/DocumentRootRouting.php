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

    /** A non-canonical exported-page filename redirected to its public URL. */
    public const CANONICAL_REDIRECT = 'redirect:canonical';

    /** An exported admin page, or the shell when the deep link has no file. */
    public const ADMIN_SHELL = 'static:admin-shell';

    /** The exported 404 document. */
    public const NOT_FOUND = 'static:404';

    /** A committed private/VCS name or extension, denied with 403. */
    public const DENIED = 'deny:403';

    /**
     * URL-path patterns of the committed private/VCS deny classes, expressed
     * the way mod_rewrite sees the request (path without the leading slash).
     *
     * These are the same classes as the `FilesMatch` deny blocks below the
     * rewrite table, but on the URL rather than on the file basename. The two
     * layers see different things: `FilesMatch` matches the last path
     * component, so it cannot see a *directory* such as `/.git` — a request
     * for `/.git/config` would otherwise be served — while the URL always
     * carries the dot-segment. Each pattern matches anywhere a segment
     * boundary allows, so the deny holds at every depth, and none of them can
     * shadow the `/api` rule, which runs first by design.
     *
     * Shared by {@see resolve()} and HtaccessRenderer so the model and the
     * generated file cannot drift.
     */
    public const SENSITIVE_PATH_PATTERNS = [
        // Dot-segment residue: `.env*`, `.git*`, `.htpasswd` — a file or a
        // directory whose name starts with one of these is never addressable.
        '(?:^|/)\.(?:env|git|htpasswd)',
        // Composer/package manifests, at any depth, by their exact name.
        '(?:^|/)(?:composer\.(?:json|lock)|package(?:-lock)?\.json)$',
        // The private extension classes denied wherever a file name carries them.
        '(?:^|/)[^/]+\.(?i:json|md|log|lock|neon|dist|example|sql|bak)$',
    ];

    /**
     * Exact public pages emitted by the static export, without their `.html`
     * suffix: the reservation flow, and (ESZ-165) the two legal pages, which
     * read the stored legal document at load exactly as `/reservation` reads
     * the catalog.
     */
    public const PUBLIC_EXPORTED_PATHS = ['/reservation', '/mentions-legales', '/confidentialite'];

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
                'id' => 'canonical-public-page',
                'description' =>
                    'The implementation filename for a declared public page redirects to its '
                    . 'extensionless canonical URL.',
                'target' => self::CANONICAL_REDIRECT,
            ],
            [
                'id' => 'public-exported-page',
                'description' =>
                    'A declared public static page such as /reservation resolves to its exported '
                    . '.html file before a same-named Next payload directory can capture it.',
                'target' => self::STATIC_FILE,
            ],
            [
                'id' => 'admin-page',
                'description' =>
                    'An admin path with an exported page (/admin/login -> admin/login.html) serves '
                    . 'that page, so a refresh or a direct link lands on the right screen.',
                'target' => self::ADMIN_SHELL,
            ],
            [
                'id' => 'sensitive-path',
                'description' =>
                    'Committed private and VCS residue (.env, .git and .htpasswd segments, '
                    . 'Composer/package manifests, the sensitive extension classes) is denied by '
                    . 'URL before the existing-file rule can serve it. The basename FilesMatch '
                    . 'layer below cannot see a dot-directory such as /.git/config, so the URL is '
                    . 'the layer that can.',
                'target' => self::DENIED,
            ],
            [
                'id' => 'existing-file',
                'description' =>
                    'After exact application routes, a request that names a real file or directory '
                    . 'is served as-is: hashed _next/ assets, RSC payloads, media and icons.',
                'target' => self::STATIC_FILE,
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

        foreach (self::PUBLIC_EXPORTED_PATHS as $publicPage) {
            if ($path === $publicPage . '.html') {
                return self::outcome(
                    'canonical-public-page',
                    self::CANONICAL_REDIRECT,
                    ltrim($publicPage, '/'),
                );
            }

            if ($path === $publicPage) {
                $candidate = $relative . '.html';

                return $fileExists($candidate)
                    ? self::outcome('public-exported-page', self::STATIC_FILE, $candidate)
                    : self::outcome('not-found', self::NOT_FOUND, '404.html');
            }
        }

        if ($path === '/admin' || str_starts_with($path, '/admin/')) {
            $candidate = $relative . '.html';

            if ($fileExists($candidate)) {
                return self::outcome('admin-page', self::ADMIN_SHELL, $candidate);
            }
        }

        // The committed private/VCS deny classes, on the URL. This sits after
        // the application rules (an unknown /api path must keep answering the
        // JSON 404 envelope, never a rewrite-level 403) and before the
        // existing-file rule, so a planted file or directory — including a
        // dot-directory, which a basename rule cannot see — is refused before
        // anything could serve it.
        foreach (self::SENSITIVE_PATH_PATTERNS as $pattern) {
            if (preg_match('#' . $pattern . '#', $relative) === 1) {
                return self::outcome('sensitive-path', self::DENIED, null);
            }
        }

        if ($relative !== '' && $fileExists($relative)) {
            return self::outcome('existing-file', self::STATIC_FILE, $relative);
        }

        if ($path === '/admin' || str_starts_with($path, '/admin/')) {
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
