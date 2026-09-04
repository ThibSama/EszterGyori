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
            'privacy' => [
                'logPseudonymizationKey' => str_repeat('a', 64),
            ],
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
            'notifications' => [
                'email' => [
                    'host' => 'smtp.example.test',
                    'port' => 587,
                    'encryption' => 'starttls',
                    'authenticationRequired' => true,
                    'username' => 'mailer',
                    'password' => 'smtp-secret',
                    'senderAddress' => 'bonjour@example.test',
                    'senderName' => 'Eszter Gyori',
                    'timeoutSeconds' => 10,
                    'customerContact' => 'Répondez à cet e-mail.',
                    'customerInstructions' => 'Prévenez-nous en cas d’empêchement.',
                ],
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
                ['privacy.logPseudonymizationKey', 'database.password', 'notifications.email.password'],
                array_column($exception->issues(), 'path'),
                'the documented secret placeholders must be the only invalid values',
            );
        }

        // With the placeholders replaced, every other key in the file is valid
        // and complete. That is what makes it usable documentation.
        $raw = self::example();
        $raw['privacy'] = ['logPseudonymizationKey' => str_repeat('b', 64)];
        /** @var array<string, mixed> $database */
        $database = $raw['database'];
        $database['password'] = 'a-real-password';
        $raw['database'] = $database;
        /** @var array<string, mixed> $notifications */
        $notifications = $raw['notifications'];
        /** @var array<string, mixed> $email */
        $email = $notifications['email'];
        $email['username'] = 'mailer';
        $email['password'] = 'smtp-secret';
        $notifications['email'] = $email;
        $raw['notifications'] = $notifications;

        $config = Configuration::fromArray($raw, $this->root . '/config');

        self::assertSame('production', $config->environment);
        self::assertStringEndsWith('/data/content', $config->contentDir);
        self::assertStringEndsWith('/public_html', $config->publicDir);
        self::assertSame('mysql', $config->requireDatabase()->driver());
        self::assertSame('eszter', $config->requireDatabase()->databaseName());
        self::assertTrue($config->session->cookieSecure);
        self::assertSame('starttls', $config->requireSmtp()->encryption);
    }

    public function testTheExampleDocumentsEveryKeyTheLoaderReads(): void
    {
        // A key the loader understands but the example never mentions is a key
        // nobody will ever set, which is how a security default silently becomes
        // the only setting anybody uses.
        $raw = self::example();

        self::assertSame(
            ['environment', 'logLevel', 'privacy', 'paths', 'database', 'session', 'notifications'],
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

        /** @var array<string, mixed> $notifications */
        $notifications = $raw['notifications'];
        /** @var array<string, mixed> $email */
        $email = $notifications['email'];
        self::assertSame(
            [
                'host', 'port', 'encryption', 'authenticationRequired', 'username', 'password',
                'senderAddress', 'senderName', 'timeoutSeconds', 'customerContact', 'customerInstructions',
            ],
            array_keys($email),
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

    public function testProductionRequiresAPrivatePseudonymizationKeyWithoutEchoingIt(): void
    {
        $raw = $this->valid();
        unset($raw['privacy']);

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('production accepted no log pseudonymization key');
        } catch (ConfigurationException $exception) {
            self::assertContains('privacy.logPseudonymizationKey', array_column($exception->issues(), 'path'));
        }

        $secret = 'recognizable-private-secret-that-must-never-be-echoed';
        $raw['privacy'] = ['logPseudonymizationKey' => $secret];
        self::assertSame($secret, Configuration::fromArray($raw, $this->root)->logPseudonymizationKey);

        foreach (['short', 'CHANGE_ME'] as $invalid) {
            $raw['privacy'] = ['logPseudonymizationKey' => $invalid];
            try {
                Configuration::fromArray($raw, $this->root);
                self::fail('production accepted an unsafe log pseudonymization key');
            } catch (ConfigurationException $exception) {
                self::assertStringNotContainsString($invalid, $exception->getMessage());
                self::assertContains('privacy.logPseudonymizationKey', array_column($exception->issues(), 'path'));
            }
        }
    }

    public function testThePseudonymizationKeyIsOptionalOutsideProductionAndNeverDefaulted(): void
    {
        $raw = $this->valid();
        $raw['environment'] = 'test';
        unset($raw['privacy']);

        self::assertNull(Configuration::fromArray($raw, $this->root)->logPseudonymizationKey);
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

    public function testProductionRequiresCompleteBoundedSmtpWithoutLeakingSecrets(): void
    {
        $raw = $this->valid();
        /** @var array<string, mixed> $notifications */
        $notifications = $raw['notifications'];
        /** @var array<string, mixed> $email */
        $email = $notifications['email'];
        $email['host'] = 'smtp://bad.example.test';
        $email['port'] = 0;
        $email['encryption'] = 'opportunistic';
        $email['timeoutSeconds'] = 31;
        $email['password'] = 'CHANGE_ME';
        $email['senderAddress'] = 'not-an-address';
        $email['senderName'] = "Header\r\nInjection";
        $notifications['email'] = $email;
        $raw['notifications'] = $notifications;

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('invalid SMTP configuration was accepted');
        } catch (ConfigurationException $exception) {
            self::assertSame(
                [
                    'notifications.email.host',
                    'notifications.email.port',
                    'notifications.email.encryption',
                    'notifications.email.password',
                    'notifications.email.senderAddress',
                    'notifications.email.senderName',
                    'notifications.email.timeoutSeconds',
                ],
                array_column($exception->issues(), 'path'),
            );
            self::assertStringNotContainsString('CHANGE_ME', $exception->getMessage());
            self::assertStringNotContainsString('smtp-secret', $exception->getMessage());
        }
    }

    public function testSmtpMayBeAbsentOnlyOutsideProduction(): void
    {
        $raw = $this->valid();
        unset($raw['notifications']);

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('production loaded without SMTP');
        } catch (ConfigurationException $exception) {
            self::assertContains('notifications.email', array_column($exception->issues(), 'path'));
        }

        $raw['environment'] = 'test';
        self::assertNull(Configuration::fromArray($raw, $this->root)->smtp);
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

    /** @return array<string, mixed> */
    private function absolutePaths(): array
    {
        $raw = $this->valid();
        $raw['paths'] = [
            'content' => $this->root . '/data/content',
            'tmp' => $this->root . '/var/tmp',
            'locks' => $this->root . '/data/locks',
            'log' => $this->root . '/var/log',
            'contracts' => '/absolute/contracts',
            'mediaOriginals' => $this->root . '/data/media-originals',
            'public' => $this->root . '/public_html',
        ];

        return $raw;
    }

    /**
     * ESZ-133: every one of the five private runtime paths is refused when it
     * is exactly the document root. The error names the offending key.
     */
    public function testEveryPrivatePathEqualToTheDocumentRootIsRefused(): void
    {
        foreach (['content', 'tmp', 'locks', 'log', 'mediaOriginals'] as $key) {
            $raw = $this->absolutePaths();
            $raw['paths'][$key] = $this->root . '/public_html';

            try {
                Configuration::fromArray($raw, $this->root);
                self::fail("paths.{$key} equal to the document root was accepted");
            } catch (ConfigurationException $exception) {
                self::assertSame(["paths.{$key}"], array_column($exception->issues(), 'path'));
                self::assertStringContainsString('document root', $exception->getMessage());
            }
        }
    }

    /** ESZ-133: a private path directly or deeply beneath public is refused. */
    public function testPrivatePathsDirectlyOrDeeplyBeneathTheDocumentRootAreRefused(): void
    {
        foreach (
            [
                'content' => '/public_html/content',
                'tmp' => '/public_html/var/tmp',
                'locks' => '/public_html/data/locks',
                'log' => '/public_html/var/log/app',
                'mediaOriginals' => '/public_html/data/media-originals/x/y/z',
            ] as $key => $suffix
        ) {
            $raw = $this->absolutePaths();
            $raw['paths'][$key] = $this->root . $suffix;

            try {
                Configuration::fromArray($raw, $this->root);
                self::fail("paths.{$key} beneath the document root was accepted");
            } catch (ConfigurationException $exception) {
                self::assertSame(["paths.{$key}"], array_column($exception->issues(), 'path'));
            }
        }
    }

    /**
     * ESZ-133: relative, `.`/`..` and mixed-separator forms that resolve to a
     * location beneath public are refused after the same canonicalization the
     * paths themselves receive.
     */
    public function testRelativeDotAndSeparatorFormsResolvingBeneathPublicAreRefused(): void
    {
        foreach (
            [
                // Relative to the base directory.
                'public_html/data/content',
                // Explicit current-directory segments.
                './public_html/./data/content',
                // Traversal that still lands inside public.
                'public_html/../public_html/data/content',
                // Repeated and mixed separators.
                "public_html//data///content",
                "public_html\\data\\content",
            ] as $form
        ) {
            $raw = $this->valid();
            $raw['paths']['public'] = $this->root . '/public_html';
            $raw['paths']['content'] = $form;

            try {
                Configuration::fromArray($raw, $this->root);
                self::fail("content form {$form} resolving beneath public was accepted");
            } catch (ConfigurationException $exception) {
                self::assertSame(['paths.content'], array_column($exception->issues(), 'path'));
            }
        }
    }

    /** ESZ-133: containment is path-component aware, not string-prefix aware. */
    public function testNeighbouringPrefixesRemainValid(): void
    {
        foreach (
            [
                'content' => '/public_html2/content',
                'tmp' => '/public-html/tmp',
                'log' => '/srv/public-old/log',
                'mediaOriginals' => '/public_html_extra/media-originals',
            ] as $key => $suffix
        ) {
            $raw = $this->absolutePaths();
            $raw['paths'][$key] = $this->root . $suffix;

            $config = Configuration::fromArray($raw, $this->root);

            self::assertSame($this->root . $suffix, $config->{$this->propertyFor($key)});
        }
    }

    /** ESZ-133: an existing symlink alias into the real document root is refused. */
    public function testASymlinkAliasIntoTheRealDocumentRootIsRefused(): void
    {
        if (!function_exists('symlink')) {
            self::markTestSkipped('symlink() is not available on this platform.');
        }

        mkdir($this->root . '/public_html', 0o700, true);
        mkdir($this->root . '/public_html/data', 0o700, true);
        symlink($this->root . '/public_html', $this->root . '/alias-to-public');

        $raw = $this->absolutePaths();
        $raw['paths']['content'] = $this->root . '/alias-to-public/data';

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('a symlink alias into the document root was accepted');
        } catch (ConfigurationException $exception) {
            self::assertSame(['paths.content'], array_column($exception->issues(), 'path'));
            self::assertStringContainsString('real path', $exception->getMessage());
        }
    }

    /** ESZ-133: the standard sibling layout beside the document root stays valid. */
    public function testPrivateSiblingsBesideTheDocumentRootRemainValid(): void
    {
        $config = Configuration::fromArray($this->absolutePaths(), $this->root);

        self::assertSame($this->root . '/data/content', $config->contentDir);
        self::assertSame($this->root . '/var/tmp', $config->tmpDir);
        self::assertSame($this->root . '/data/locks', $config->lockDir);
        self::assertSame($this->root . '/var/log', $config->logDir);
        self::assertSame($this->root . '/data/media-originals', $config->mediaOriginalsDir);
        self::assertSame($this->root . '/public_html', $config->publicDir);
    }

    /** ESZ-133: the committed development topology remains valid. */
    public function testTheDevelopmentTopologyRemainsValid(): void
    {
        $path = TestEnvironment::repositoryRoot() . '/php/config/config.development.php';
        /** @var array<string, mixed> $raw */
        $raw = require $path;

        $config = Configuration::fromArray($raw, \dirname($path));

        self::assertSame('development', $config->environment);
        self::assertStringEndsWith('/data/content', $config->contentDir);
        self::assertStringEndsWith('/var/log', $config->logDir);
        self::assertStringEndsWith('/front/out', $config->publicDir);
    }

    /**
     * ESZ-133: the managed-media area stays `<public>/media` — the one
     * web-reachable exception — and is not a private path. A *private* path
     * pointing at it is still refused, because the exception belongs to the
     * media pipeline, not to any private key.
     */
    public function testMediaPublicDirStaysTheOnlyWebReachableException(): void
    {
        $config = Configuration::fromArray($this->absolutePaths(), $this->root);

        self::assertSame($this->root . '/public_html/media', $config->mediaPublicDir());

        $raw = $this->absolutePaths();
        $raw['paths']['log'] = $this->root . '/public_html/media';

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('a private path inside the managed-media area was accepted');
        } catch (ConfigurationException $exception) {
            self::assertSame(['paths.log'], array_column($exception->issues(), 'path'));
        }
    }

    /**
     * ESZ-133: `contracts` is deliberately not part of the private-path list —
     * its artifacts are build inputs copied into the deployment — so it may sit
     * under the document root without tripping the topology refusal.
     */
    public function testContractsBeneathTheDocumentRootRemainsAcceptedByDesign(): void
    {
        $raw = $this->absolutePaths();
        $raw['paths']['contracts'] = $this->root . '/public_html/contracts';

        $config = Configuration::fromArray($raw, $this->root);

        self::assertSame($this->root . '/public_html/contracts', $config->contractsDir);
    }

    /**
     * ESZ-102: production mail must be encrypted on the wire. A production
     * configuration asking for plaintext SMTP is refused during configuration,
     * and the refusal names the setting — never the credentials beside it.
     */
    public function testProductionRejectsPlaintextSmtpNamingTheSettingWithoutSecrets(): void
    {
        $raw = $this->valid();
        /** @var array<string, mixed> $email */
        $email = $raw['notifications']['email'];
        $email['encryption'] = 'none';
        $raw['notifications']['email'] = $email;

        try {
            Configuration::fromArray($raw, $this->root);
            self::fail('production accepted plaintext SMTP');
        } catch (ConfigurationException $exception) {
            self::assertSame(
                ['notifications.email.encryption'],
                array_column($exception->issues(), 'path'),
            );
            $message = $exception->getMessage();
            self::assertStringContainsString('notifications.email.encryption', $message);
            self::assertStringContainsString('starttls', $message);
            self::assertStringContainsString('smtps', $message);

            // Proof: the refusal names the setting and never leaks the
            // configured username, password, host or any other value.
            self::assertStringNotContainsString('mailer', $message);
            self::assertStringNotContainsString('smtp-secret', $message);
            self::assertStringNotContainsString('smtp.example.test', $message);
        }
    }

    /** ESZ-102: plaintext SMTP stays legal outside production. */
    public function testPlaintextSmtpRemainsLegalOutsideProduction(): void
    {
        foreach (['development', 'test'] as $environment) {
            $raw = $this->valid();
            /** @var array<string, mixed> $email */
            $email = $raw['notifications']['email'];
            $email['encryption'] = 'none';
            $raw['notifications']['email'] = $email;
            $raw['environment'] = $environment;

            $config = Configuration::fromArray($raw, $this->root);

            self::assertFalse($config->isProduction());
            self::assertSame('none', $config->requireSmtp()->encryption);
        }
    }

    /** ESZ-102: production accepts the two encrypted modes and only those. */
    public function testProductionAcceptsTheTwoEncryptedSmtpModes(): void
    {
        foreach (['starttls', 'smtps'] as $encryption) {
            $raw = $this->valid();
            /** @var array<string, mixed> $email */
            $email = $raw['notifications']['email'];
            $email['encryption'] = $encryption;
            $raw['notifications']['email'] = $email;

            $config = Configuration::fromArray($raw, $this->root);

            self::assertTrue($config->isProduction());
            self::assertSame($encryption, $config->requireSmtp()->encryption);
        }
    }

    private function propertyFor(string $key): string
    {
        return match ($key) {
            'content' => 'contentDir',
            'tmp' => 'tmpDir',
            'locks' => 'lockDir',
            'log' => 'logDir',
            'mediaOriginals' => 'mediaOriginalsDir',
            default => throw new \LogicException("no property for {$key}"),
        };
    }
}
