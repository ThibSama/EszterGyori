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
                'mediaOriginals' => '../data/media-originals',
                'public' => '../public_html',
            ],
            // ESZ-023/027. Required in production, so every production fixture in
            // this file carries one.
            'database' => [
                'dsn' => 'mysql:host=localhost;dbname=eszter;charset=utf8mb4',
                'username' => 'eszter',
                'password' => 'a-real-password',
            ],
        ];
    }

    /** @return array<string, mixed> */
    private static function example(): array
    {
        /** @var array<string, mixed> $raw */
        $raw = require TestEnvironment::repositoryRoot() . '/php/config/config.example.php';

        return $raw;
    }

    public function testTheCommittedExampleIsStructurallyCompleteButRefusesItsOwnPlaceholder(): void
    {
        // The example is documentation only if it actually loads — and ESZ-027
        // adds the opposite requirement on top: a deployment that copies it and
        // forgets to edit the secret must not boot. Both halves are asserted here,
        // because a change that satisfied either one alone would be a regression.
        try {
            Configuration::fromFile(
                TestEnvironment::repositoryRoot() . '/php/config/config.example.php',
            );
            self::fail('the example loaded with its placeholder password still in it');
        } catch (ConfigurationException $exception) {
            self::assertSame(
                ['database.password'],
                array_column($exception->issues(), 'path'),
                'the placeholder must be the *only* thing wrong with the example',
            );
        }

        // With the one placeholder replaced, every other key in the file is valid
        // and complete. That is what makes it usable documentation.
        $raw = self::example();
        /** @var array<string, mixed> $database */
        $database = $raw['database'];
        $database['password'] = 'a-real-password';
        $raw['database'] = $database;

        $config = Configuration::fromArray($raw, $this->root . '/config');

        self::assertSame('production', $config->environment);
        self::assertStringEndsWith('/data/content', $config->contentDir);
        self::assertStringEndsWith('/public_html', $config->publicDir);
        self::assertSame('mysql', $config->requireDatabase()->driver());
        self::assertSame('eszter', $config->requireDatabase()->databaseName());
        self::assertTrue($config->session->cookieSecure);
    }

    public function testTheExampleDocumentsEveryKeyTheLoaderReads(): void
    {
        // A key the loader understands but the example never mentions is a key
        // nobody will ever set, which is how a security default silently becomes
        // the only setting anybody uses.
        $raw = self::example();

        self::assertSame(
            ['environment', 'logLevel', 'paths', 'database', 'session'],
            array_keys($raw),
        );

        /** @var array<string, mixed> $database */
        $database = $raw['database'];
        self::assertSame(
            ['dsn', 'username', 'password', 'connectTimeoutSeconds'],
            array_keys($database),
        );

        /** @var array<string, mixed> $session */
        $session = $raw['session'];
        self::assertSame(
            ['idleTimeoutMinutes', 'absoluteLifetimeMinutes', 'cookieSecure'],
            array_keys($session),
        );
    }

    public function testRelativePathsResolveAgainstTheConfigFile(): void
    {
        $path = $this->writeConfigFile($this->valid());

        $config = Configuration::fromFile($path);

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
        /** @var array<string, mixed> $database */
        $database = $raw['database'];
        $database['password'] = '';
        $raw['database'] = $database;

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('an invalid configuration was accepted');
        } catch (ConfigurationException $exception) {
            // One deploy attempt should surface every problem, not the first one.
            self::assertSame(
                ['environment', 'logLevel', 'paths.tmp', 'paths.locks', 'database.password'],
                array_column($exception->issues(), 'path'),
            );
        }
    }

    public function testAMissingPathsSectionIsFatalRatherThanDefaulted(): void
    {
        $this->expectException(ConfigurationException::class);

        Configuration::fromArray(['environment' => 'test'], $this->root);
    }

    public function testAWorldReadableConfigFileIsRefusedInProduction(): void
    {
        // ESZ-027 / `docs/hetzner-target-architecture.md` §9: the file holding the
        // database password is mode 0600. On shared hosting a group- or
        // world-readable secret is readable by the other tenants, so this is a
        // refusal rather than a warning.
        $path = $this->writeConfigFile($this->valid(), 0o644);

        try {
            Configuration::fromFile($path);
            self::fail('a world-readable production configuration was accepted');
        } catch (ConfigurationException $exception) {
            self::assertSame(['config file'], array_column($exception->issues(), 'path'));

            // The refusal names the mode, never the secret it is protecting.
            self::assertStringNotContainsString('a-real-password', $exception->getMessage());
        }

        chmod($path, 0o600);
        self::assertTrue(Configuration::fromFile($path)->isProduction());
    }

    public function testALooseConfigFileIsToleratedOutsideProduction(): void
    {
        // A developer's checkout is routinely 0644. Refusing to boot over it there
        // would only teach people to ignore the check when it fires for real.
        $raw = $this->valid();
        $raw['environment'] = 'development';

        $config = Configuration::fromFile($this->writeConfigFile($raw, 0o644));

        self::assertFalse($config->isProduction());
    }

    public function testProductionRefusesAnUnsafeDatabaseOrSessionSetting(): void
    {
        $raw = $this->valid();
        /** @var array<string, mixed> $database */
        $database = $raw['database'];
        // SQLite would run the whole admin surface against a file the next deploy
        // replaces, with every test still green.
        $database['dsn'] = 'sqlite:/tmp/eszter.sqlite';
        $raw['database'] = $database;
        // Without Secure the session cookie can be stripped onto plain HTTP.
        $raw['session'] = ['cookieSecure' => false];

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('an unsafe production configuration was accepted');
        } catch (ConfigurationException $exception) {
            self::assertSame(
                ['database.dsn', 'session.cookieSecure'],
                array_column($exception->issues(), 'path'),
            );
        }
    }

    public function testTheDatabaseIsOptionalOutsideProductionAndRequiredInside(): void
    {
        $raw = $this->valid();
        unset($raw['database']);

        // The public read-only surface touches no database, so a non-production
        // deployment without one is legal and boots.
        $raw['environment'] = 'test';
        self::assertNull(Configuration::fromArray($raw, $this->root)->database);

        $raw['environment'] = 'production';
        $this->expectException(ConfigurationException::class);
        Configuration::fromArray($raw, $this->root);
    }

    public function testDatabaseSettingsNeverSerialiseTheirCredentials(): void
    {
        $settings = Configuration::fromArray($this->valid(), $this->root)->requireDatabase();

        // Three separate ways a secret escapes a value object by accident, all
        // closed. `describe()` is the only form meant for a log line.
        foreach (
            [
                (string) json_encode($settings),
                print_r($settings, true),
                var_export($settings->__debugInfo(), true),
                $settings->describe(),
            ] as $rendering
        ) {
            self::assertStringNotContainsString('a-real-password', $rendering);
        }

        self::assertSame('mysql:eszter', $settings->describe());
    }

    /** @param array<string, mixed> $raw */
    private function writeConfigFile(array $raw, int $mode = 0o600): string
    {
        if (!is_dir($this->root . '/config')) {
            mkdir($this->root . '/config', 0o700, true);
        }

        $path = $this->root . '/config/config.php';
        file_put_contents($path, '<?php return ' . var_export($raw, true) . ';');
        chmod($path, $mode);

        return $path;
    }

    public function testTraversalSegmentsAreCollapsedNotPreserved(): void
    {
        $raw = $this->valid();
        $raw['paths']['content'] = 'data/./x/../content';

        $config = Configuration::fromArray($raw, $this->root);

        self::assertSame($this->root . '/data/content', $config->contentDir);
    }
}
