<?php

declare(strict_types=1);

namespace Eszter\Http;

/**
 * An inbound request, decoupled from PHP superglobals so the whole HTTP layer is
 * testable without a web server.
 */
final class Request
{
    /**
     * @param array<string, string> $headers Lower-cased header names.
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $headers = [],
        public readonly string $rawBody = '',
    ) {
    }

    /** @param array<string, mixed> $server */
    public static function fromGlobals(array $server, string $rawBody = ''): self
    {
        /** @var string $method */
        $method = \is_string($server['REQUEST_METHOD'] ?? null) ? $server['REQUEST_METHOD'] : 'GET';
        /** @var string $uri */
        $uri = \is_string($server['REQUEST_URI'] ?? null) ? $server['REQUEST_URI'] : '/';

        $path = parse_url($uri, PHP_URL_PATH);

        return new self(
            strtoupper($method),
            \is_string($path) && $path !== '' ? $path : '/',
            self::headersFromServer($server),
            $rawBody,
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function hasJsonContentType(): bool
    {
        $contentType = $this->header('content-type');

        if ($contentType === null) {
            return false;
        }

        $mediaType = strtolower(trim(explode(';', $contentType)[0]));

        return $mediaType === 'application/json' || str_ends_with($mediaType, '+json');
    }

    /**
     * @param array<string, mixed> $server
     * @return array<string, string>
     */
    private static function headersFromServer(array $server): array
    {
        $headers = [];

        foreach ($server as $key => $value) {
            if (!\is_string($key) || !\is_string($value)) {
                continue;
            }

            if (str_starts_with($key, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = $value;
                continue;
            }

            // CONTENT_TYPE and CONTENT_LENGTH arrive without the HTTP_ prefix.
            if ($key === 'CONTENT_TYPE' || $key === 'CONTENT_LENGTH') {
                $headers[strtolower(str_replace('_', '-', $key))] = $value;
            }
        }

        return $headers;
    }
}
