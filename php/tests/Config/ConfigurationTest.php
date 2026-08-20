<?php

declare(strict_types=1);

namespace Eszter\Tests\Config;

use Eszter\Config\Configuration;
use Eszter\Config\ConfigurationException;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * `docs/hetzner-target-architecture.md` §9: invalid or missing configuration
 * aborts. It must never fall back to defaults and serve a half-configured site.
 */
final class ConfigurationTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-config');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    /** @return array<string, mixed> */
    private function valid(): array
    {
        return [
            'environment' => 'production',
            'logLevel' => 'warn',
            'paths' => [
                'content' => '../data/content',
                'tmp' => '../var/tmp',
                'locks' => '../data/locks',
                'log' => '../var/log',
                'contracts' => '/absolute/contracts',
                'public' => '../public_html',
            ],
        ];
    }

    public function testTheCommittedExampleIsValid(): void
    {
        // The example is documentation only if it actually loads.
        $config = Configuration::fromFile(
            TestEnvironment::repositoryRoot() . '/php/config/config.example.php',
        );

        self::assertSame('production', $config->environment);
        self::assertStringEndsWith('/data/content', $config->contentDir);
        self::assertStringEndsWith('/public_html', $config->publicDir);
    }

    public function testRelativePathsResolveAgainstTheConfigFile(): void
    {
        mkdir($this->root . '/config', 0o700, true);
        file_put_contents(
            $this->root . '/config/config.php',
            '<?php return ' . var_export($this->valid(), true) . ';',
        );

        $config = Configuration::fromFile($this->root . '/config/config.php');

        self::assertSame($this->root . '/data/content', $config->contentDir);
        self::assertSame($this->root . '/var/tmp', $config->tmpDir);
        self::assertSame('/absolute/contracts', $config->contractsDir);
        // ESZ-021: the document root is configuration now, because `/` is served
        // by reading the export out of it.
        self::assertSame($this->root . '/public_html', $config->publicDir);
        self::assertSame($this->root . '/var/log/app.log', $config->logFile());
        self::assertTrue($config->isProduction());
    }

    public function testAMissingFileIsFatal(): void
    {
        $this->expectException(ConfigurationException::class);

        Configuration::fromFile($this->root . '/absent.php');
    }

    public function testAFileThatDoesNotReturnAnArrayIsFatal(): void
    {
        file_put_contents($this->root . '/bad.php', '<?php return "nope";');

        $this->expectException(ConfigurationException::class);

        Configuration::fromFile($this->root . '/bad.php');
    }

    public function testAllProblemsAreReportedAtOnce(): void
    {
        $raw = $this->valid();
        $raw['environment'] = 'staging';
        $raw['logLevel'] = 'verbose';
        unset($raw['paths']['tmp']);
        $raw['paths']['locks'] = '   ';

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('an invalid configuration was accepted');
        } catch (ConfigurationException $exception) {
            // One deploy attempt should surface every problem, not the first one.
            self::assertSame(
                ['environment', 'logLevel', 'paths.tmp', 'paths.locks'],
                array_column($exception->issues(), 'path'),
            );
        }
    }

    public function testAMissingPathsSectionIsFatalRatherThanDefaulted(): void
    {
        $this->expectException(ConfigurationException::class);

        Configuration::fromArray(['environment' => 'test'], $this->root);
    }

    public function testTraversalSegmentsAreCollapsedNotPreserved(): void
    {
        $raw = $this->valid();
        $raw['paths']['content'] = 'data/./x/../content';

        $config = Configuration::fromArray($raw, $this->root);

        self::assertSame($this->root . '/data/content', $config->contentDir);
    }
}
