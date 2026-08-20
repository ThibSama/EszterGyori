<?php

declare(strict_types=1);

namespace Eszter\Deploy;

/**
 * Renders the document-root `.htaccess` files from {@see DocumentRootRouting}.
 *
 * Generated rather than hand-written so that the file Apache reads and the table
 * the suite exercises cannot drift apart — the same reason `contracts/generated/`
 * is generated and digest-checked. `HtaccessTest` regenerates and compares, so
 * hand-editing the committed file fails a gate instead of quietly becoming the
 * only description of the routing.
 *
 * Two files, because `.htaccess` context rules force it: `<Directory>` is only
 * legal in server config, so "no PHP under media/" has to be a second file
 * *inside* `media/` rather than a block in the root one. A `<Directory>` block in
 * `.htaccess` is not ignored — Apache refuses to serve the directory at all — so
 * this is the difference between a hardened site and a 500.
 */
final class HtaccessRenderer
{
    public const BANNER = 'GENERATED FILE - do not edit by hand. Run: php php/bin/generate-htaccess.php';

    /** Filenames that must never be executed or served, wherever they appear. */
    private const PHP_FILE_PATTERN = '\\.(?i:php[0-9]?|phtml|phar|inc)$';

    /**
     * The only file names `media/` may serve: a managed asset, and nothing else.
     *
     * Expressed as a negative lookahead so the rule is a *whitelist* — the thing
     * a deny-list of extensions can never be. Ingest stages the derivative inside
     * this directory before renaming it into place (`rename()` is only atomic
     * within one filesystem), so for a moment there is a file here that is not an
     * asset; this rule is what makes that moment harmless rather than a window.
     *
     * It also stops mattering *why* a stray file appeared. A leftover staging
     * file, a backup an operator dropped in, an original someone copied across:
     * none of them are addressable, because none of them are named
     * `med_<32 hex>.<jpg|png|webp>`. The php deny-list below stays as well —
     * belt and braces on the one directory where untrusted bytes land.
     */
    private const MEDIA_ASSET_NAME_PATTERN = '^(?!med_[0-9a-f]{32}\\.(?:jpg|png|webp)$).*$';

    /**
     * The generated files, keyed by their path relative to the document root.
     *
     * @return array<string, string>
     */
    public static function files(): array
    {
        return [
            '.htaccess' => self::renderDocumentRoot(),
            'media/.htaccess' => self::renderMedia(),
        ];
    }

    public static function renderDocumentRoot(): string
    {
        $banner = self::BANNER;
        $ruleComments = self::renderRuleComments();
        $reserved = implode('|', array_map(
            static fn (string $path): string => preg_quote(ltrim($path, '/'), '#'),
            DocumentRootRouting::RESERVED_PATHS,
        ));
        $phpFiles = self::PHP_FILE_PATTERN;

        return <<<HTACCESS
            # {$banner}
            #
            # Document-root routing and hardening for Hetzner webhosting.
            # docs/hetzner-target-architecture.md §3 and §12.
            #
            # The ORDER of the rewrite rules is the specification, not a detail:
            #
            {$ruleComments}

            Options -Indexes -MultiViews

            # `/` must reach the front controller so the published content can be
            # injected into the exported page. If Apache were allowed to resolve the
            # root to index.html on its own, it would serve the file the build
            # produced — correct-looking, permanently out of date, and very hard to
            # notice. Disabling the index is what makes that impossible rather than
            # merely unlikely.
            DirectoryIndex disabled

            ErrorDocument 404 /404.html

            <IfModule mod_rewrite.c>
                RewriteEngine On

                # 1. /api/* — first, and ahead of the existing-file check, so nothing
                #    under the document root can shadow an API path and answer HTML
                #    where the contract froze a JSON envelope.
                RewriteRule ^api(/.*)?$ api/index.php [QSA,L]

                # 2. The exported page is only ever served through the front
                #    controller. Asking for it by name would return the uninjected
                #    build output, so that spelling is canonicalised away before
                #    rule 3 could serve the file.
                RewriteRule ^index\\.html$ / [R=301,L]

                # 3. A real file or directory is served as-is: hashed _next/ assets,
                #    media, icons, robots.txt.
                #
                #    The root is excluded explicitly. `%{REQUEST_FILENAME}` for `/`
                #    is the document root itself, which *is* a directory, so without
                #    this condition the rule would match and end the chain — and with
                #    DirectoryIndex disabled the site root would 403 instead of
                #    reaching rule 7.
                RewriteCond %{REQUEST_URI} !^/$
                RewriteCond %{REQUEST_FILENAME} -f [OR]
                RewriteCond %{REQUEST_FILENAME} -d
                RewriteRule ^ - [L]

                # 4. Reserved paths resolve to the 404 document. Above the admin and
                #    public rules so a reserved path cannot be captured by either.
                RewriteRule ^({$reserved})(/.*)?$ - [L,R=404]

                # 5. /admin/<page> -> admin/<page>.html when the export has one, so a
                #    refresh or a direct link lands on the right screen.
                RewriteCond %{DOCUMENT_ROOT}/\$1.html -f
                RewriteRule ^(admin(?:/.*)?)\$ \$1.html [L]

                # 6. Any other /admin path -> the shell, so a client-side route
                #    survives a refresh instead of 404-ing.
                RewriteRule ^admin(/.*)?\$ admin.html [L]

                # 7. The site root -> the front controller, which injects the
                #    published content into the exported index.html (ESZ-021).
                RewriteRule ^\$ api/index.php [QSA,L]

                # 8. Anything else is the 404 document. Unknown /api paths never
                #    reach here: rule 1 already claimed them, and they answer the
                #    frozen JSON envelope instead.
                RewriteRule ^ - [L,R=404]
            </IfModule>

            # Nothing below the document root is web-reachable by design. These deny
            # rules are defence in depth for the case where the hosting plan cannot
            # place data/ and config/ outside it (§3, rule 3).
            <FilesMatch "\\.(?i:json|md|log|lock|neon|dist|example|sql|bak)\$">
                Require all denied
            </FilesMatch>

            <FilesMatch "^(?:\\.env.*|\\.git.*|\\.htpasswd|composer\\.(?:json|lock)|package(?:-lock)?\\.json)\$">
                Require all denied
            </FilesMatch>

            # api/index.php is the only PHP file that may run, and it is reached
            # through rule 1 rather than by name. Everything else matching this
            # pattern is denied wherever it appears (§3, rule 1).
            <FilesMatch "{$phpFiles}">
                Require all denied
            </FilesMatch>

            <Files "index.php">
                Require all granted
            </Files>

            <IfModule mod_headers.c>
                Header always unset X-Powered-By
                Header always unset Server
                Header always set X-Content-Type-Options "nosniff"
                Header always set Referrer-Policy "strict-origin-when-cross-origin"
                Header always set X-Frame-Options "SAMEORIGIN"

                # Hashed build assets are immutable: the file name changes when the
                # contents do. HTML is excluded — the page carries its own
                # revision-derived ETag and must revalidate every time.
                <FilesMatch "\\.(?i:js|css|woff2?|svg|png|jpe?g|webp|avif|ico)\$">
                    Header always set Cache-Control "public, max-age=31536000, immutable"
                </FilesMatch>
            </IfModule>

            # HTTPS and HSTS are enabled at deploy time, once a certificate exists.
            # Committed commented-out rather than omitted: redirecting to https on a
            # host with no certificate is an outage, and browsers remember HSTS long
            # after the header is removed. See docs/hetzner-target-architecture.md §3.
            #
            # <IfModule mod_rewrite.c>
            #     RewriteCond %{HTTPS} !=on
            #     RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
            # </IfModule>
            #
            # <IfModule mod_headers.c>
            #     Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
            # </IfModule>

            HTACCESS;
    }

    public static function renderMedia(): string
    {
        $banner = self::BANNER;
        $phpFiles = self::PHP_FILE_PATTERN;
        $assetNames = self::MEDIA_ASSET_NAME_PATTERN;

        return <<<HTACCESS
            # {$banner}
            #
            # docs/hetzner-target-architecture.md §7: an upload that lands here must
            # be inert, whatever it claims to be.
            #
            # A separate file rather than a block in the root .htaccess because
            # `<Directory>` is only legal in server config; used in .htaccess it makes
            # Apache refuse the directory outright.
            #
            # `Require all denied` rather than `php_flag engine off`: the flag needs
            # mod_php, and on a PHP-FPM host it is not merely ineffective but an
            # "Invalid command" 500. Refusing to serve the file at all is both
            # portable and stronger — it does not depend on which SAPI is running.

            Options -Indexes -ExecCGI

            # Only a managed asset is addressable here. Everything else — a
            # staging file mid-ingest, a stray copy, anything at all — is denied
            # by name rather than by extension, so the rule cannot be got past
            # by finding a spelling the deny-list forgot.
            <FilesMatch "{$assetNames}">
                Require all denied
            </FilesMatch>

            <FilesMatch "{$phpFiles}">
                Require all denied
            </FilesMatch>

            RemoveHandler .php .phtml .phar
            RemoveType .php .phtml .phar

            <IfModule mod_headers.c>
                # A managed asset is immutable: its name carries a random id
                # minted once at ingest and never reused, and the ingest never
                # rewrites a file it has already published. Replacing an image
                # means a new id and a new URL, so these can be cached forever.
                Header always set Cache-Control "public, max-age=31536000, immutable"
                Header always set X-Content-Type-Options "nosniff"
                Header always set Content-Disposition "inline"
            </IfModule>

            HTACCESS;
    }

    private static function renderRuleComments(): string
    {
        $lines = [];

        foreach (DocumentRootRouting::rules() as $index => $rule) {
            $lines[] = \sprintf(
                "#   %d. %s\n#      %s",
                $index + 1,
                $rule['id'],
                wordwrap($rule['description'], 70, "\n#      "),
            );
        }

        return implode("\n#\n", $lines);
    }
}
