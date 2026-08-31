<?php

declare(strict_types=1);

namespace Eszter\Tests\Deploy;

use Eszter\Deploy\DocumentRootRouting;
use Eszter\Deploy\HtaccessRenderer;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Eszter\Tests\TestEnvironment;

/**
 * Document-root routing (ESZ-022).
 *
 * These assert the *table*, which is the thing `.htaccess` is generated from. It
 * is not a substitute for exercising Apache — `smoke:http` is what will do that,
 * once there is an origin to point it at — but it does cover the failures that
 * are actually likely: a rule added in the wrong position, a new path quietly
 * captured by the admin catch-all, or the API stopping being first.
 *
 * The file list mirrors a real `next build` under `trailingSlash: false`, because
 * the resolution of `/admin/login` depends entirely on whether the export emits
 * `admin/login.html` or `admin/login/index.html`. Getting that pairing wrong is
 * the classic static-hosting bug, and it only shows up on the host.
 */
final class DocumentRootRoutingTest extends TestCase
{
    /** What `next build` puts in the document root. */
    private const EXPORTED_FILES = [
        'index.html',
        '404.html',
        'admin.html',
        'admin/login.html',
        'admin/preview.html',
        'reservation.html',
        'robots.txt',
        'sitemap.xml',
        'manifest.webmanifest',
        'icon.svg',
        'favicon.ico',
        '_next/static/chunks/main-abc123.js',
        '_next/static/css/app-abc123.css',
        'media/portrait-01.webp',
    ];

    /** @return array{rule: string, target: string, file: string|null} */
    private function resolve(string $path): array
    {
        return DocumentRootRouting::resolve(
            $path,
            static fn (string $candidate): bool => \in_array($candidate, self::EXPORTED_FILES, true),
        );
    }

    /** @return iterable<string, array{string, string, string}> */
    public static function routes(): iterable
    {
        $api = DocumentRootRouting::FRONT_CONTROLLER;
        $file = DocumentRootRouting::STATIC_FILE;
        $admin = DocumentRootRouting::ADMIN_SHELL;

        // path => [rule, target, why it matters]
        yield 'the site root is served by PHP' => ['/', 'public-page', $api];
        yield 'the health endpoint' => ['/api/health', 'api', $api];
        yield 'the content endpoint' => ['/api/content', 'api', $api];
        yield 'an unknown API path still reaches PHP' => ['/api/nope', 'api', $api];
        yield 'a future admin API path reaches PHP' => ['/api/admin/content/draft', 'api', $api];
        yield 'the bare /api prefix reaches PHP' => ['/api', 'api', $api];

        yield 'hashed JS is served directly' => [
            '/_next/static/chunks/main-abc123.js', 'existing-file', $file,
        ];
        yield 'hashed CSS is served directly' => [
            '/_next/static/css/app-abc123.css', 'existing-file', $file,
        ];
        yield 'media is served directly' => ['/media/portrait-01.webp', 'existing-file', $file];
        yield 'robots.txt is served directly' => ['/robots.txt', 'existing-file', $file];
        yield 'the web manifest is served directly' => [
            '/manifest.webmanifest', 'existing-file', $file,
        ];

        yield 'the admin entry point' => ['/admin', 'admin-page', $admin];
        yield 'an exported admin page' => ['/admin/login', 'admin-page', $admin];
        yield 'the admin preview' => ['/admin/preview', 'admin-page', $admin];
        yield 'an admin deep link with no file falls back to the shell' => [
            '/admin/content/hero', 'admin-deep-link', $admin,
        ];

        yield 'the public reservation page' => [
            '/reservation', 'public-exported-page', $file,
        ];
        yield 'an unknown reservation subpath' => [
            '/reservation/creneaux', 'not-found', DocumentRootRouting::NOT_FOUND,
        ];

        yield 'an unknown document path' => [
            '/nope', 'not-found', DocumentRootRouting::NOT_FOUND,
        ];
    }

    #[DataProvider('routes')]
    public function testRoutesResolveDeterministically(string $path, string $rule, string $target): void
    {
        $outcome = $this->resolve($path);

        self::assertSame($rule, $outcome['rule'], $path);
        self::assertSame($target, $outcome['target'], $path);
    }

    public function testAnAdminDeepLinkServesTheShellRatherThan404ingOnRefresh(): void
    {
        // The failure this prevents only happens on the second visit: the link
        // works when the app navigates to it client-side, then 404s when the
        // browser is refreshed on it.
        self::assertSame('admin.html', $this->resolve('/admin/content/hero')['file']);
        self::assertSame('admin/login.html', $this->resolve('/admin/login')['file']);
        self::assertSame('admin.html', $this->resolve('/admin')['file']);
    }

    public function testTheApiIsResolvedBeforeAnythingCanShadowIt(): void
    {
        // §12 rule 1, as a property rather than as an ordering of lines: even a
        // file sitting at the API's exact path does not take it, because the API
        // rule runs before the existing-file check. A JSON 404 that arrives as
        // HTML is a contract violation, not a cosmetic problem.
        $outcome = DocumentRootRouting::resolve(
            '/api/content',
            static fn (): bool => true, // every conceivable file exists
        );

        self::assertSame('api', $outcome['rule']);
        self::assertSame(DocumentRootRouting::FRONT_CONTROLLER, $outcome['target']);
    }

    public function testTheReservationPageIsAnExactStaticExportRoute(): void
    {
        self::assertSame('reservation.html', $this->resolve('/reservation')['file']);
        self::assertSame(DocumentRootRouting::STATIC_FILE, $this->resolve('/reservation')['target']);
        self::assertSame(DocumentRootRouting::NOT_FOUND, $this->resolve('/reservation/creneaux')['target']);
    }

    public function testAStaticAssetOutranksEveryPathRule(): void
    {
        // The other half of the ordering above, stated so the precedence is a
        // decision on the record rather than an accident of line order.
        self::assertSame('existing-file', $this->resolve('/admin/login.html')['rule']);
        self::assertSame('existing-file', $this->resolve('/404.html')['rule']);
        self::assertSame(
            'existing-file',
            $this->resolve('/_next/static/chunks/main-abc123.js')['rule'],
        );
    }

    public function testTheReservationPathShipsTheBookingInterface(): void
    {
        self::assertSame(DocumentRootRouting::STATIC_FILE, $this->resolve('/reservation')['target']);
        self::assertFileExists(
            TestEnvironment::repositoryRoot() . '/front/app/reservation',
        );
    }

    public function testTheRootIsNeverResolvedAsAStaticFile(): void
    {
        // If `/` ever resolved to index.html directly, the site would serve the
        // build output forever and publishing would appear to do nothing. This is
        // the single most valuable assertion in the file.
        $outcome = DocumentRootRouting::resolve('/', static fn (): bool => true);

        self::assertSame(DocumentRootRouting::FRONT_CONTROLLER, $outcome['target']);
        self::assertNull($outcome['file']);
    }

    public function testEveryDeclaredRuleIsReachable(): void
    {
        // A rule nobody can hit is either dead or shadowed by an earlier one; both
        // are bugs, and both are invisible without this.
        $reached = [];
        foreach (self::routes() as [$path, $rule]) {
            $reached[$rule] = true;
            self::assertSame($rule, $this->resolve($path)['rule'], $path);
        }

        $declared = array_column(DocumentRootRouting::rules(), 'id');

        sort($declared);
        $reachedIds = array_keys($reached);
        sort($reachedIds);

        self::assertSame($declared, $reachedIds, 'a declared rule has no covering case');
    }

    public function testTheCommittedHtaccessMatchesTheRoutingTable(): void
    {
        // Drift guard, same idea as `contracts:verify:generated`: the file Apache
        // reads must be the file this table renders, or the tests above are
        // describing something that is not deployed.
        $publicDir = TestEnvironment::repositoryRoot() . '/php/public';

        foreach (HtaccessRenderer::files() as $relativePath => $expected) {
            $path = $publicDir . '/' . $relativePath;

            self::assertFileExists($path, "run: php php/bin/generate-htaccess.php");
            self::assertSame(
                $expected,
                file_get_contents($path),
                "public/{$relativePath} is stale. Run: php php/bin/generate-htaccess.php",
            );
        }
    }

    public function testTheGeneratedHtaccessUsesOnlyDirectivesLegalInThatContext(): void
    {
        // `<Directory>` in .htaccess is not ignored — Apache refuses to serve the
        // directory at all, so a "hardening" line would take the whole site down.
        // `php_flag` needs mod_php and is an "Invalid command" 500 under PHP-FPM.
        foreach (HtaccessRenderer::files() as $relativePath => $contents) {
            $directives = array_filter(
                array_map('trim', explode("\n", $contents)),
                static fn (string $line): bool => $line !== '' && !str_starts_with($line, '#'),
            );

            foreach ($directives as $line) {
                self::assertStringStartsNotWith('<Directory', $line, $relativePath);
                self::assertStringStartsNotWith('<VirtualHost', $line, $relativePath);
                self::assertStringStartsNotWith('php_flag', $line, $relativePath);
                self::assertStringStartsNotWith('php_value', $line, $relativePath);
            }
        }
    }

    public function testPhpExecutionIsDeniedWhereverUploadsCanLand(): void
    {
        $media = HtaccessRenderer::files()['media/.htaccess'];

        self::assertStringContainsString('Require all denied', $media);
        self::assertStringContainsString('phtml', $media);
        self::assertStringContainsString('Options -Indexes', $media);
    }

    /**
     * ESZ-036. `media/` serves managed assets and nothing else, and the rule that
     * says so is a whitelist rather than another deny-list.
     *
     * The pattern is extracted from the generated file and executed here, because
     * a negative-lookahead `FilesMatch` is exactly the kind of directive that
     * looks right and matches the opposite of what its author meant. Apache
     * compiles it with PCRE, so running it through `preg_match` is the same engine
     * answering the same question.
     */
    public function testOnlyAManagedAssetIsAddressableUnderMedia(): void
    {
        $media = HtaccessRenderer::files()['media/.htaccess'];

        self::assertSame(
            1,
            preg_match('/<FilesMatch "(\^\(\?!med_.*?)">/', $media, $found),
            'the media .htaccess declares no managed-asset whitelist',
        );

        $pattern = '#' . str_replace('\\.', '\.', $found[1]) . '#';
        $id = 'med_' . str_repeat('0', 32);

        // Denied means the pattern matches: the rule is `Require all denied`.
        foreach (
            [
                // The staging file the ingest writes before its final rename.
                '.staging-' . str_repeat('a', 32),
                // Anything an operator or a mistake might leave behind.
                'portrait.jpg',
                'index.php',
                $id . '.php',
                $id . '.jpg.php',
                $id . '.svg',
                $id . '.JPG',
                'med_' . str_repeat('g', 32) . '.jpg',
                $id . '.jpg.bak',
                'x' . $id . '.jpg',
            ] as $denied
        ) {
            self::assertSame(1, preg_match($pattern, $denied), "{$denied} is reachable");
        }

        // And a real asset is not denied, or the site would serve no images at all.
        foreach (["{$id}.jpg", "{$id}.png", "{$id}.webp"] as $served) {
            self::assertSame(0, preg_match($pattern, $served), "{$served} is denied");
        }
    }
}
