<?php

declare(strict_types=1);

namespace Eszter\Tests\Deploy;

use Eszter\Config\Configuration;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-133: with a valid topology, private files are not directly served.
 *
 * A deployment is materialised in the documented sibling layout — `public_html`
 * beside `data/` and `var/` — with canaries in every private location (content
 * draft/published, log, tmp, media originals). The real local document-root
 * surface, the committed `php/public/router.php` on PHP's built-in server, is
 * started against that document root, and plausible direct URLs must not
 * retrieve any canary while a legitimate public file and a managed-media file
 * must both be served. No system Apache daemon is involved.
 */
final class PrivatePathIsolationTest extends TestCase
{
    private string $root;
    private string $docroot;
    private string $baseUrl = '';
    /** @var resource|null */
    private $server = null;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-private-paths');
        $this->docroot = $this->root . '/public_html';

        foreach (
            [
                $this->docroot . '/media',
                $this->root . '/data/content',
                $this->root . '/data/media-originals',
                $this->root . '/data/locks',
                $this->root . '/var/log',
                $this->root . '/var/tmp',
            ] as $directory
        ) {
            if (!mkdir($directory, 0o700, true) && !is_dir($directory)) {
                self::fail("could not create {$directory}");
            }
        }

        // Canaries: exactly the files a deployment keeps in these locations.
        file_put_contents($this->root . '/data/content/draft.json', '{"draft":"ESZ133-CANARY-DRAFT"}');
        file_put_contents($this->root . '/data/content/published.json', '{"published":"ESZ133-CANARY-PUBLISHED"}');
        file_put_contents($this->root . '/var/log/app.log', "2026-09-01 ESZ133-CANARY-LOG secret line\n");
        file_put_contents($this->root . '/var/tmp/upload.bin', 'ESZ133-CANARY-TMP');
        file_put_contents($this->root . '/data/media-originals/portrait.webp', 'ESZ133-CANARY-ORIGINAL');

        // Positive controls inside the document root.
        file_put_contents($this->docroot . '/index.html', '<html>ESZ133-PUBLIC-INDEX</html>');
        file_put_contents(
            $this->docroot . '/media/' . $this->managedAssetId() . '.webp',
            'ESZ133-PUBLIC-MEDIA',
        );

        // The deployment's own configuration must pass the ESZ-133 topology
        // validation, or this proof would be serving a layout the app refuses.
        $configPath = TestEnvironment::writeDeployment($this->root, [
            'paths' => [
                'content' => $this->root . '/data/content',
                'tmp' => $this->root . '/var/tmp',
                'locks' => $this->root . '/data/locks',
                'log' => $this->root . '/var/log',
                'contracts' => '/absolute/contracts',
                'mediaOriginals' => $this->root . '/data/media-originals',
                'public' => $this->docroot,
            ],
        ]);
        $config = Configuration::fromFile($configPath);
        self::assertSame($this->docroot, $config->publicDir);
        self::assertSame($this->docroot . '/media', $config->mediaPublicDir());

        $this->startServer();
    }

    protected function tearDown(): void
    {
        if (is_resource($this->server)) {
            proc_terminate($this->server);
            proc_close($this->server);
            $this->server = null;
        }

        TestEnvironment::removeDirectory($this->root);
    }

    public function testPlausibleDirectUrlsCannotRetrievePrivateFiles(): void
    {
        foreach (
            [
                '/data/content/draft.json',
                '/data/content/published.json',
                '/var/log/app.log',
                '/var/tmp/upload.bin',
                '/data/media-originals/portrait.webp',
                '/media-originals/portrait.webp',
            ] as $path
        ) {
            [$status, $body] = $this->get($path);

            self::assertSame(404, $status, $path);
            self::assertStringNotContainsString('ESZ133-CANARY', $body, $path);
        }
    }

    public function testTraversalCannotReachPrivateFiles(): void
    {
        foreach (
            [
                '/../var/log/app.log',
                '/data/content/../../var/log/app.log',
                '/data/./../var/tmp/upload.bin',
                '/%2e%2e/var/log/app.log',
                '/..%2fvar%2flog%2fapp.log',
                '/var/log/%2e%2e/%2e%2e/data/content/draft.json',
            ] as $path
        ) {
            [$status, $body] = $this->get($path);

            self::assertSame(404, $status, $path);
            self::assertStringNotContainsString('ESZ133-CANARY', $body, $path);
        }
    }

    public function testLegitimatePublicAndManagedFilesAreServed(): void
    {
        [$indexStatus, $indexBody] = $this->get('/index.html');
        self::assertSame(200, $indexStatus);
        self::assertStringContainsString('ESZ133-PUBLIC-INDEX', $indexBody);

        [$mediaStatus, $mediaBody] = $this->get('/media/' . $this->managedAssetId() . '.webp');
        self::assertSame(200, $mediaStatus);
        self::assertStringContainsString('ESZ133-PUBLIC-MEDIA', $mediaBody);
    }

    /** The frozen managed-asset filename shape: `med_` plus 32 hex characters. */
    private function managedAssetId(): string
    {
        return 'med_' . str_repeat('0', 32);
    }

    /**
     * @return array{int, string} The HTTP status and the response body.
     */
    private function get(string $path): array
    {
        $context = stream_context_create([
            'http' => [
                'timeout' => 5,
                'ignore_errors' => true,
                'follow_location' => false,
            ],
        ]);
        $body = @file_get_contents($this->baseUrl . $path, false, $context);

        $status = 0;
        foreach ($http_response_header as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $found) === 1) {
                $status = (int) $found[1];
                break;
            }
        }

        return [$status, (string) $body];
    }

    private function startServer(): void
    {
        $port = $this->freePort();
        $router = TestEnvironment::repositoryRoot() . '/php/public/router.php';

        $process = proc_open(
            [PHP_BINARY, '-S', "127.0.0.1:{$port}", '-t', $this->docroot, $router],
            [
                0 => ['file', '/dev/null', 'r'],
                1 => ['file', $this->root . '/server.out', 'w'],
                2 => ['file', $this->root . '/server.err', 'w'],
            ],
            $pipes,
            TestEnvironment::repositoryRoot(),
            array_merge(getenv(), ['ESZTER_EXPORT_ROOT' => $this->docroot]),
        );
        self::assertIsResource($process);
        $this->server = $process;
        $this->baseUrl = "http://127.0.0.1:{$port}";

        $deadline = microtime(true) + 5.0;
        do {
            $probe = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);

            if ($probe !== false) {
                fclose($probe);

                return;
            }

            usleep(50_000);
        } while (microtime(true) < $deadline);

        self::fail("the built-in server did not start on port {$port}");
    }

    private function freePort(): int
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        self::assertIsResource($socket);
        $name = (string) stream_socket_get_name($socket, false);
        fclose($socket);
        $port = (int) substr($name, (int) strrpos($name, ':') + 1);
        self::assertGreaterThan(0, $port);

        return $port;
    }
}
