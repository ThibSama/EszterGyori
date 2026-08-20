<?php

declare(strict_types=1);

namespace Eszter\Tests;

use Eszter\Contract\ContractArtifacts;

/**
 * Shared locations for the test suite.
 *
 * The contract artifacts are read from the repository's `contracts/generated/`
 * — the same committed files a deploy copies to the host. Tests deliberately do
 * not get a fixture copy: a fixture is one more thing that can go stale.
 */
final class TestEnvironment
{
    public static function repositoryRoot(): string
    {
        return \dirname(__DIR__, 2);
    }

    public static function contractsDirectory(): string
    {
        return self::repositoryRoot() . '/contracts/generated';
    }

    public static function artifacts(): ContractArtifacts
    {
        return new ContractArtifacts(self::contractsDirectory());
    }

    /** Creates an empty scratch directory that {@see removeDirectory} cleans up. */
    public static function makeTempDirectory(string $prefix): string
    {
        $path = sys_get_temp_dir() . '/' . $prefix . '-' . bin2hex(random_bytes(6));

        if (!mkdir($path, 0o700, true) && !is_dir($path)) {
            throw new \RuntimeException("Could not create temp directory {$path}");
        }

        return $path;
    }

    /**
     * Materialises a self-contained deployment (config file, data, tmp, locks,
     * log) in a scratch directory and returns the config path.
     *
     * The contract artifacts are pointed at the repository copy rather than
     * copied, so a test can never pass against a stale snapshot of them.
     *
     * @param array<string, mixed> $overrides Merged over the generated config.
     */
    public static function writeDeployment(string $root, array $overrides = []): string
    {
        foreach (['data/content', 'var/tmp', 'data/locks', 'var/log', 'public_html'] as $directory) {
            if (!is_dir($root . '/' . $directory) && !mkdir($root . '/' . $directory, 0o700, true)) {
                throw new \RuntimeException("Could not create {$root}/{$directory}");
            }
        }

        $config = [
            'environment' => 'test',
            'logLevel' => 'error',
            'paths' => [
                'content' => $root . '/data/content',
                'tmp' => $root . '/var/tmp',
                'locks' => $root . '/data/locks',
                'log' => $root . '/var/log',
                'contracts' => self::contractsDirectory(),
                'public' => $root . '/public_html',
            ],
        ] ;

        $config = array_replace_recursive($config, $overrides);
        $path = $root . '/config.php';

        file_put_contents($path, '<?php return ' . var_export($config, true) . ';' . PHP_EOL);

        return $path;
    }

    /**
     * Writes a stand-in for the Next export into a deployment's document root.
     *
     * A fixture rather than the real `front/out/index.html`, because that file
     * only exists after a frontend build and PHPUnit must not depend on one. What
     * matters to the injector is not the page's design but its *shape*: the two
     * elements it locates by id, and the fact that the surrounding document is
     * carried through untouched.
     *
     * So the fixture is deliberately awkward. The ids sit among other attributes
     * and in a different order than the export writes them, which is what proves
     * the injector matches on `id` and not on a remembered opening tag. It also
     * carries a decoy `<script>` and a marker outside both elements, so a
     * replacement that is too greedy fails a test instead of production.
     *
     * @param string $bakedMarker Text baked into the body, standing in for the
     *        canonical copy a visitor sees when injection does not happen.
     */
    public static function writeExportedPage(
        string $root,
        string $bakedMarker = 'BAKED-DEFAULT-COPY',
    ): string {
        $artifacts = self::artifacts();
        $baked = json_encode([
            'schemaVersion' => $artifacts->contentSchemaVersion(),
            'revision' => 0,
            'publishedAt' => null,
            'content' => $artifacts->canonicalSiteContent(),
        ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_UNICODE);

        $html = <<<HTML
            <!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
            <title>Eszter Gyori</title>
            <style data-precedence="next" id="__ESZTER_APPEARANCE__">:root{--site-background:#F5F4F1}</style>
            </head><body><div id="__next">{$bakedMarker}</div>
            <script type="application/json" id="__ESZTER_CONTENT__" data-nscript="before">{$baked}</script>
            <script>window.__DECOY__=1</script>
            <!-- PAGE-TAIL-MARKER -->
            </body></html>
            HTML;

        $path = $root . '/public_html/index.html';
        file_put_contents($path, $html);

        return $path;
    }

    public static function removeDirectory(string $path): void
    {
        if (!is_dir($path)) {
            return;
        }

        $entries = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST,
        );

        foreach ($entries as $entry) {
            /** @var \SplFileInfo $entry */
            $entry->isDir() ? @rmdir($entry->getPathname()) : @unlink($entry->getPathname());
        }

        @rmdir($path);
    }
}
