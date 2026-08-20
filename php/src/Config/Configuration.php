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
        return self::fromArray($raw, \dirname($path));
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
        );
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
