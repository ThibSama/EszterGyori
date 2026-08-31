<?php

declare(strict_types=1);

namespace Eszter\Http;

use Eszter\Media\UploadedFile;

/**
 * An inbound request, decoupled from PHP superglobals so the whole HTTP layer is
 * testable without a web server.
 */
final class Request
{
    /**
     * @param array<string, string> $headers Lower-cased header names.
     * @param list<UploadedFile> $uploads Multipart parts, if any (ESZ-036).
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $headers = [],
        public readonly string $rawBody = '',
        /**
         * The request's file parts.
         *
         * Separate from {@see $rawBody} because PHP makes them separate: on a
         * `multipart/form-data` request `php://input` is empty and the parts are
         * in `$_FILES`, so a layer that only knew about the raw body would see an
         * upload as a request with no body at all.
         */
        public readonly array $uploads = [],
        /**
         * The peer address of the TCP connection, or null when there is none —
         * a CLI invocation, or a test that did not supply one.
         *
         * This is `REMOTE_ADDR` and only ever `REMOTE_ADDR`. It is deliberately
         * *not* derived from `X-Forwarded-For`, `X-Real-IP` or `Forwarded`, and
         * it is not part of {@see $headers} at all, so no code can reach for the
         * header spelling by accident.
         *
         * ESZ-084 made this matter: it is what the rate limiter charges against.
         * A caller who could name their own address could pick a fresh one per
         * request, which would turn every bucket into a formality. On the target
         * host Apache is the origin and `REMOTE_ADDR` is the real peer; if this
         * application is ever put behind a proxy that rewrites it, honouring a
         * forwarding header becomes a deliberate change with a trusted-proxy
         * list, not a default. `rateLimitPolicy.forwardedHeadersTrusted` is
         * `false` and {@see \Eszter\Security\RateLimitPolicy} asserts it.
         */
        public readonly ?string $clientAddress = null,
    ) {
    }

    /**
     * The subject the rate limiter charges an anonymous caller against.
     *
     * A request with no peer address — which on this runtime means it did not
     * arrive over the network — is charged to one shared bucket rather than
     * skipping the limiter. Skipping would make "send no address" the way past
     * every rule, and a limiter with a documented bypass is decoration.
     */
    public function rateLimitAddress(): string
    {
        return $this->clientAddress ?? 'unknown';
    }

    /**
     * @param array<string, mixed> $server
     * @param array<mixed> $files The `$_FILES` superglobal.
     */
    public static function fromGlobals(array $server, string $rawBody = '', array $files = []): self
    {
        /** @var string $method */
        $method = \is_string($server['REQUEST_METHOD'] ?? null) ? $server['REQUEST_METHOD'] : 'GET';
        /** @var string $uri */
        $uri = \is_string($server['REQUEST_URI'] ?? null) ? $server['REQUEST_URI'] : '/';

        $path = parse_url($uri, PHP_URL_PATH);

        /** @var mixed $remote */
        $remote = $server['REMOTE_ADDR'] ?? null;

        return new self(
            strtoupper($method),
            \is_string($path) && $path !== '' ? $path : '/',
            self::headersFromServer($server),
            $rawBody,
            UploadedFile::fromPhpFiles($files),
            // `REMOTE_ADDR` never arrives with an `HTTP_` prefix, so it cannot be
            // set by a caller sending a header of that name — which is exactly
            // why it is the value the limiter trusts.
            \is_string($remote) && $remote !== '' ? $remote : null,
        );
    }

    /**
     * Whether this request declared a multipart body.
     *
     * Used to tell "an upload arrived with no parts" — which is what PHP produces
     * when `post_max_size` was exceeded, silently and with no error code — from
     * "this was never an upload". The two need different answers and are
     * otherwise indistinguishable.
     */
    public function hasMultipartContentType(): bool
    {
        $contentType = $this->header('content-type');

        if ($contentType === null) {
            return false;
        }

        return str_starts_with(strtolower(trim($contentType)), 'multipart/form-data');
    }

    /** The declared body length, or null when the request declared none. */
    public function declaredContentLength(): ?int
    {
        $value = $this->header('content-length');

        if ($value === null || preg_match('/^\d{1,19}$/', trim($value)) !== 1) {
            return null;
        }

        return (int) trim($value);
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
