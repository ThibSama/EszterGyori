<?php

declare(strict_types=1);

namespace Eszter\Config;

/**
 * Validated application configuration.
 *
 * Read from a PHP file returning an array, not from environment variables:
 * shared hosting offers no reliable per-process environment
 * (`docs/hetzner-target-architecture.md` §9). `config/config.example.php`
 * documents every key.
 *
 * Validation is fail-fast and total — every key is checked before any of them is
 * used, so a misconfiguration reports all of its problems at once instead of one
 * per deploy attempt.
 */
final class Configuration
{
    public const ENVIRONMENTS = ['development', 'test', 'production'];
    public const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

    private function __construct(
        public readonly string $environment,
        public readonly string $logLevel,
        public readonly string $contentDir,
        public readonly string $tmpDir,
        public readonly string $lockDir,
        public readonly string $logDir,
        public readonly string $contractsDir,
        public readonly string $publicDir,
        /**
         * Uploaded originals (ESZ-036). A sibling of the document root, never
         * inside it: an original is the caller's own bytes, kept only so a
         * derivative can be rebuilt, and nothing must be able to request one.
         */
        public readonly string $mediaOriginalsDir,
        /**
         * Null when no operational database is configured. That is legal outside
         * production — the public read-only surface needs no SQL at all — and
         * fatal inside it, because the admin surface does.
         */
        public readonly ?DatabaseSettings $database,
        public readonly SessionSettings $session,
        /** Null outside production when SMTP is deliberately not configured. */
        public readonly ?SmtpSettings $smtp,
    ) {
    }

    public static function fromFile(string $path): self
    {
        if (!is_file($path) || !is_readable($path)) {
            throw new ConfigurationException("Configuration file is missing or unreadable: {$path}");
        }

        /** @var mixed $raw */
        $raw = require $path;

        if (!\is_array($raw)) {
            throw new ConfigurationException(
                "Configuration file must return an array: {$path}",
            );
        }

        /** @var array<mixed> $raw */
        $config = self::fromArray($raw, \dirname($path));

        // ESZ-027. Checked here rather than in fromArray() because it is a fact
        // about the *file*, and fromArray() is also how a test builds a
        // configuration that never touched a disk.
        //
        // Only in production: a developer's checkout is routinely 0644 and
        // refusing to boot over it would teach people to chmod 0600 and then
        // ignore the check when it fires for real.
        if ($config->isProduction()) {
            $config->assertConfigFileIsPrivate($path);
        }

        return $config;
    }

    /**
     * `docs/hetzner-target-architecture.md` §9: the file holding the DB password
     * is mode 0600, owned by the application user. A world- or group-readable
     * secret on shared hosting is readable by other tenants, so this is a refusal
     * rather than a warning.
     */
    private function assertConfigFileIsPrivate(string $path): void
    {
        $mode = @fileperms($path);

        if ($mode === false) {
            throw new ConfigurationException(
                "Configuration file permissions could not be read: {$path}",
            );
        }

        if (($mode & 0o077) !== 0) {
            throw ConfigurationException::invalid([[
                'path' => 'config file',
                'message' => \sprintf(
                    'must not be readable by group or others (found %04o, expected 0600). '
                    . 'It holds the database password.',
                    $mode & 0o777,
                ),
            ]]);
        }
    }

    /**
     * @param array<mixed> $raw
     * @param string $baseDir Root that relative paths resolve against.
     */
    public static function fromArray(array $raw, string $baseDir): self
    {
        /** @var list<array{path: string, message: string}> $issues */
        $issues = [];

        $environment = self::enum($raw, 'environment', self::ENVIRONMENTS, 'production', $issues);
        $logLevel = self::enum($raw, 'logLevel', self::LOG_LEVELS, 'info', $issues);

        /** @var mixed $paths */
        $paths = $raw['paths'] ?? null;
        if (!\is_array($paths)) {
            $issues[] = ['path' => 'paths', 'message' => 'must be an array of directory paths.'];
            $paths = [];
        }

        /** @var array<mixed> $paths */
        $contentDir = self::path($paths, 'content', $baseDir, $issues);
        $tmpDir = self::path($paths, 'tmp', $baseDir, $issues);
        $lockDir = self::path($paths, 'locks', $baseDir, $issues);
        $logDir = self::path($paths, 'log', $baseDir, $issues);
        $contractsDir = self::path($paths, 'contracts', $baseDir, $issues);
        // The exported frontend. Required since ESZ-021: `/` is served by
        // reading `index.html` from here and injecting into it, so a deployment
        // that forgot the export must fail at boot with a named key rather than
        // 500 on the home page.
        $publicDir = self::path($paths, 'public', $baseDir, $issues);
        // Required rather than derived from `content`. Deriving it would make
        // the one directory that must stay unreachable depend on the shape of a
        // path someone else configured, and a deployment that got it wrong would
        // find out by serving an original rather than by failing to boot.
        $mediaOriginalsDir = self::path($paths, 'mediaOriginals', $baseDir, $issues);

        $isProduction = $environment === 'production';
        $database = self::database($raw, $isProduction, $issues);
        $session = self::session($raw, $isProduction, $issues);
        $smtp = self::smtp($raw, $isProduction, $issues);

        if ($issues !== []) {
            throw ConfigurationException::invalid($issues);
        }

        return new self(
            $environment,
            $logLevel,
            $contentDir,
            $tmpDir,
            $lockDir,
            $logDir,
            $contractsDir,
            $publicDir,
            $mediaOriginalsDir,
            $database,
            $session,
            $smtp,
        );
    }

    /**
     * Production SMTP is explicit and fail-fast. No credential value is ever
     * copied into an issue message, including when it is a known placeholder.
     *
     * @param array<mixed> $raw
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function smtp(array $raw, bool $isProduction, array &$issues): ?SmtpSettings
    {
        /** @var mixed $notifications */
        $notifications = $raw['notifications'] ?? null;
        if ($notifications === null) {
            if ($isProduction) {
                $issues[] = ['path' => 'notifications.email', 'message' => 'is required in production.'];
            }

            return null;
        }
        if (!\is_array($notifications)) {
            $issues[] = ['path' => 'notifications', 'message' => 'must be an array.'];

            return null;
        }

        /** @var mixed $email */
        $email = $notifications['email'] ?? null;
        if (!\is_array($email)) {
            $issues[] = ['path' => 'notifications.email', 'message' => 'must be an array of SMTP settings.'];

            return null;
        }

        $before = \count($issues);
        $host = self::requiredString($email, 'notifications.email.host', $issues);
        if (
            $host !== ''
            && (mb_strlen($host) > 253 || preg_match('/[\s\x00-\x1F\x7F:\/]/u', $host) === 1)
        ) {
            $issues[] = [
                'path' => 'notifications.email.host',
                'message' => 'must be a hostname or IP literal without a scheme, port or control characters.',
            ];
        }

        $port = self::boundedInt($email, 'port', 'notifications.email.port', 1, 65535, 587, $issues);
        $encryption = self::nestedEnum(
            $email,
            'encryption',
            'notifications.email.encryption',
            ['none', 'starttls', 'smtps'],
            'starttls',
            $issues,
        );
        /** @var mixed $authenticationRequired */
        $authenticationRequired = $email['authenticationRequired'] ?? null;
        if (!\is_bool($authenticationRequired)) {
            $issues[] = [
                'path' => 'notifications.email.authenticationRequired',
                'message' => 'must be a boolean.',
            ];
            $authenticationRequired = true;
        }

        $username = self::optionalConfigString($email, 'username', 'notifications.email.username', $issues);
        $password = self::optionalConfigString($email, 'password', 'notifications.email.password', $issues, false);
        if ($authenticationRequired) {
            if ($username === null) {
                $issues[] = [
                    'path' => 'notifications.email.username',
                    'message' => 'is required when SMTP authentication is enabled.',
                ];
            }
            if ($password === null) {
                $issues[] = [
                    'path' => 'notifications.email.password',
                    'message' => 'is required when SMTP authentication is enabled.',
                ];
            } elseif (\in_array($password, ['CHANGE_ME', 'CHANGEME', 'password'], true)) {
                $issues[] = [
                    'path' => 'notifications.email.password',
                    'message' => 'is still a placeholder.',
                ];
            }
        } elseif ($username !== null || $password !== null) {
            $issues[] = [
                'path' => 'notifications.email.authenticationRequired',
                'message' => 'must be true when SMTP credentials are configured.',
            ];
        }

        $senderAddress = self::requiredString($email, 'notifications.email.senderAddress', $issues);
        if ($senderAddress !== '' && filter_var($senderAddress, FILTER_VALIDATE_EMAIL) === false) {
            $issues[] = ['path' => 'notifications.email.senderAddress', 'message' => 'must be a valid address.'];
        }
        $senderName = self::safeDisplayText($email, 'notifications.email.senderName', 120, $issues);
        $customerContact = self::safeDisplayText(
            $email,
            'notifications.email.customerContact',
            300,
            $issues,
        );
        $customerInstructions = self::safeDisplayText(
            $email,
            'notifications.email.customerInstructions',
            1000,
            $issues,
        );
        $timeout = self::boundedInt(
            $email,
            'timeoutSeconds',
            'notifications.email.timeoutSeconds',
            1,
            30,
            10,
            $issues,
        );

        if (\count($issues) !== $before) {
            return null;
        }

        return new SmtpSettings(
            $host,
            $port,
            $encryption,
            $authenticationRequired,
            $username,
            $password,
            $senderAddress,
            $senderName,
            $timeout,
            $customerContact,
            $customerInstructions,
        );
    }

    /**
     * @param array<mixed> $raw
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function boundedInt(
        array $raw,
        string $key,
        string $path,
        int $minimum,
        int $maximum,
        int $default,
        array &$issues,
    ): int {
        $value = $raw[$key] ?? null;
        if (!\is_int($value) || $value < $minimum || $value > $maximum) {
            $issues[] = ['path' => $path, 'message' => "must be an integer between {$minimum} and {$maximum}."];

            return $default;
        }

        return $value;
    }

    /**
     * @param array<mixed> $raw
     * @param list<string> $allowed
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function nestedEnum(
        array $raw,
        string $key,
        string $path,
        array $allowed,
        string $default,
        array &$issues,
    ): string {
        $value = $raw[$key] ?? null;
        if (!\is_string($value) || !\in_array($value, $allowed, true)) {
            $issues[] = ['path' => $path, 'message' => 'must be one of: ' . implode(', ', $allowed) . '.'];

            return $default;
        }

        return $value;
    }

    /**
     * @param array<mixed> $raw
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function optionalConfigString(
        array $raw,
        string $key,
        string $path,
        array &$issues,
        bool $trim = true,
    ): ?string {
        $value = $raw[$key] ?? null;
        if ($value === null || $value === '') {
            return null;
        }
        if (!\is_string($value)) {
            $issues[] = ['path' => $path, 'message' => 'must be a string or null.'];

            return null;
        }

        return $trim ? trim($value) : $value;
    }

    /**
     * @param array<mixed> $raw
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function safeDisplayText(
        array $raw,
        string $path,
        int $maxLength,
        array &$issues,
    ): string {
        $value = self::requiredString($raw, $path, $issues);
        if ($value !== '' && (mb_strlen($value) > $maxLength || preg_match('/[\r\n\x00]/u', $value) === 1)) {
            $issues[] = [
                'path' => $path,
                'message' => "must be at most {$maxLength} characters and contain no line breaks or NUL bytes.",
            ];
        }

        return $value;
    }

    /**
     * The operational database (ESZ-023).
     *
     * Absent is allowed outside production and refused inside it. The three extra
     * production rules below all exist because the failure they prevent is silent:
     * a placeholder password connects to nothing but reads as configured, an
     * absent password may connect *successfully* to a server left open, and a
     * `sqlite:` DSN would run the whole admin surface against a file that the next
     * deploy overwrites, with every test still green.
     *
     * @param array<mixed> $raw
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function database(array $raw, bool $isProduction, array &$issues): ?DatabaseSettings
    {
        /** @var mixed $database */
        $database = $raw['database'] ?? null;

        if ($database === null) {
            if ($isProduction) {
                $issues[] = [
                    'path' => 'database',
                    'message' => 'is required in production: the admin surface has nowhere to '
                        . 'store sessions without it.',
                ];
            }

            return null;
        }

        if (!\is_array($database)) {
            $issues[] = ['path' => 'database', 'message' => 'must be an array of connection settings.'];

            return null;
        }

        $before = \count($issues);
        $dsn = self::requiredString($database, 'database.dsn', $issues);
        $username = self::requiredString($database, 'database.username', $issues);

        /** @var mixed $rawPassword */
        $rawPassword = $database['password'] ?? null;
        if (!\is_string($rawPassword)) {
            $issues[] = [
                'path' => 'database.password',
                'message' => 'must be a string. Use an empty string only for a local socket '
                    . 'login that has no password.',
            ];
            $rawPassword = '';
        }

        /** @var mixed $rawTimeout */
        $rawTimeout = $database['connectTimeoutSeconds'] ?? 5;
        if (!\is_int($rawTimeout) || $rawTimeout < 1 || $rawTimeout > 60) {
            $issues[] = [
                'path' => 'database.connectTimeoutSeconds',
                'message' => 'must be an integer between 1 and 60.',
            ];
            $rawTimeout = 5;
        }

        if ($isProduction) {
            if ($rawPassword === '') {
                $issues[] = [
                    'path' => 'database.password',
                    'message' => 'must not be empty in production.',
                ];
            } elseif (\in_array($rawPassword, DatabaseSettings::PLACEHOLDERS, true)) {
                // Compared against the example file's placeholders. The value is
                // never echoed back — naming it would put it in the log.
                $issues[] = [
                    'path' => 'database.password',
                    'message' => 'is still one of the placeholders from config.example.php.',
                ];
            }

            if ($dsn !== '' && !str_starts_with(strtolower($dsn), 'mysql:')) {
                $issues[] = [
                    'path' => 'database.dsn',
                    'message' => 'must be a mysql: DSN in production; the target host runs MySQL.',
                ];
            }
        }

        if (\count($issues) !== $before) {
            return null;
        }

        return new DatabaseSettings($dsn, $username, $rawPassword, $rawTimeout);
    }

    /**
     * @param array<mixed> $raw
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function session(array $raw, bool $isProduction, array &$issues): SessionSettings
    {
        /** @var mixed $session */
        $session = $raw['session'] ?? [];

        if (!\is_array($session)) {
            $issues[] = ['path' => 'session', 'message' => 'must be an array of session settings.'];
            $session = [];
        }

        /** @var array<mixed> $session */
        $idle = self::positiveMinutes(
            $session,
            'idleTimeoutMinutes',
            SessionSettings::DEFAULT_IDLE_TIMEOUT_MINUTES,
            $issues,
        );
        $absolute = self::positiveMinutes(
            $session,
            'absoluteLifetimeMinutes',
            SessionSettings::DEFAULT_ABSOLUTE_LIFETIME_MINUTES,
            $issues,
        );

        if ($absolute < $idle) {
            $issues[] = [
                'path' => 'session.absoluteLifetimeMinutes',
                'message' => 'must be at least session.idleTimeoutMinutes, otherwise the idle '
                    . 'timeout can never be reached.',
            ];
        }

        /** @var mixed $secure */
        $secure = $session['cookieSecure'] ?? true;
        if (!\is_bool($secure)) {
            $issues[] = ['path' => 'session.cookieSecure', 'message' => 'must be a boolean.'];
            $secure = true;
        }

        if ($isProduction && $secure !== true) {
            // Without Secure the session cookie travels on a plain-HTTP request —
            // one forced <img src="http://…"> is enough — and the whole
            // server-side session model is worth nothing.
            $issues[] = [
                'path' => 'session.cookieSecure',
                'message' => 'must be true in production. A session cookie without Secure can '
                    . 'be stripped onto plain HTTP.',
            ];
            $secure = true;
        }

        return new SessionSettings($idle, $absolute, $secure);
    }

    /**
     * @param array<mixed> $raw
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function requiredString(array $raw, string $path, array &$issues): string
    {
        $key = substr($path, (int) strrpos($path, '.') + 1);
        /** @var mixed $value */
        $value = $raw[$key] ?? null;

        if (!\is_string($value) || trim($value) === '') {
            $issues[] = ['path' => $path, 'message' => 'must be a non-empty string.'];

            return '';
        }

        return trim($value);
    }

    /**
     * @param array<mixed> $raw
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function positiveMinutes(array $raw, string $key, int $default, array &$issues): int
    {
        /** @var mixed $value */
        $value = $raw[$key] ?? $default;

        if (!\is_int($value) || $value < 1 || $value > 60 * 24 * 30) {
            $issues[] = [
                'path' => "session.{$key}",
                'message' => 'must be an integer number of minutes between 1 and 43200.',
            ];

            return $default;
        }

        return $value;
    }

    /**
     * The database settings, or a hard failure.
     *
     * Call sites that need SQL are all admin-surface call sites, and on those a
     * missing database is a misconfiguration rather than a reason to degrade.
     * Returning null to them would only move the null check somewhere less
     * informative.
     */
    public function requireDatabase(): DatabaseSettings
    {
        if ($this->database === null) {
            throw new ConfigurationException(
                'No `database` block is configured; the admin surface requires one.',
            );
        }

        return $this->database;
    }

    public function requireSmtp(): SmtpSettings
    {
        if ($this->smtp === null) {
            throw new ConfigurationException(
                'No `notifications.email` block is configured; the SMTP runner requires one.',
            );
        }

        return $this->smtp;
    }

    public function isProduction(): bool
    {
        return $this->environment === 'production';
    }

    public function logFile(): string
    {
        return $this->logDir . \DIRECTORY_SEPARATOR . 'app.log';
    }

    /**
     * Where a multipart part is parked while it is inspected (ESZ-036).
     *
     * A hidden subdirectory *of the originals directory*, not of `paths.tmp`.
     * That looks arbitrary and is not: the intake file is renamed into place as
     * the original once it verifies, and `rename()` is only atomic within one
     * filesystem. Putting intake inside the directory it graduates into makes
     * that true by construction, so no configuration mistake can turn the final
     * step of ingest into a non-atomic copy.
     *
     * It inherits "never web-reachable" from its parent for free.
     */
    public function mediaIntakeDir(): string
    {
        return $this->mediaOriginalsDir . \DIRECTORY_SEPARATOR . '.intake';
    }

    /**
     * The one web-reachable media location.
     *
     * Not configurable, because it is not a deployment choice: the public path
     * of every managed asset is frozen in the contract as `/media/<id>.<ext>`,
     * and the directory that serves it is that path resolved against the
     * document root. Making it a setting would let a config file silently move
     * the files out from under the URLs stored in published content.
     */
    public function mediaPublicDir(): string
    {
        return $this->publicDir . \DIRECTORY_SEPARATOR . 'media';
    }

    /**
     * @param array<mixed> $raw
     * @param list<string> $allowed
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function enum(
        array $raw,
        string $key,
        array $allowed,
        string $default,
        array &$issues,
    ): string {
        /** @var mixed $value */
        $value = $raw[$key] ?? $default;

        if (!\is_string($value) || !\in_array($value, $allowed, true)) {
            $issues[] = [
                'path' => $key,
                'message' => 'must be one of: ' . implode(', ', $allowed) . '.',
            ];

            return $default;
        }

        return $value;
    }

    /**
     * @param array<mixed> $paths
     * @param list<array{path: string, message: string}> $issues
     * @param-out list<array{path: string, message: string}> $issues
     */
    private static function path(
        array $paths,
        string $key,
        string $baseDir,
        array &$issues,
    ): string {
        /** @var mixed $value */
        $value = $paths[$key] ?? null;

        if (!\is_string($value) || trim($value) === '') {
            $issues[] = ['path' => "paths.{$key}", 'message' => 'must be a non-empty path.'];

            return '';
        }

        $value = trim($value);

        return self::isAbsolute($value)
            ? self::normalize($value)
            : self::normalize($baseDir . \DIRECTORY_SEPARATOR . $value);
    }

    private static function isAbsolute(string $path): bool
    {
        return str_starts_with($path, '/') || (bool) preg_match('#^[A-Za-z]:[\\\\/]#', $path);
    }

    /**
     * Lexical normalisation. Deliberately not `realpath()`: the target directory
     * may not exist yet at configuration time, and `realpath()` returns false
     * for those instead of the path we are about to create.
     */
    private static function normalize(string $path): string
    {
        $prefix = str_starts_with($path, '/') ? '/' : '';
        $segments = [];

        foreach (preg_split('#[\\\\/]+#', $path) ?: [] as $segment) {
            if ($segment === '' || $segment === '.') {
                continue;
            }
            if ($segment === '..') {
                array_pop($segments);
                continue;
            }
            $segments[] = $segment;
        }

        return $prefix . implode('/', $segments);
    }
}
