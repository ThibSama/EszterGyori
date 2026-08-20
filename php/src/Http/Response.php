<?php

declare(strict_types=1);

namespace Eszter\Http;

/**
 * An outbound response, built in memory and only then written out, so tests
 * assert on the same object the front controller emits.
 */
final class Response
{
    public const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

    /** @param array<string, string> $headers */
    private function __construct(
        public readonly int $status,
        public readonly array $headers,
        public readonly string $body,
    ) {
    }

    /** @param array<string, string> $headers */
    public static function json(int $status, mixed $payload, array $headers = []): self
    {
        // JSON_UNESCAPED_UNICODE keeps the French copy as UTF-8 rather than \uXXXX
        // escapes, matching what the reference service sends byte for byte.
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        if ($body === false) {
            throw new \RuntimeException('Response payload could not be encoded as JSON.');
        }

        return new self($status, ['Content-Type' => self::JSON_CONTENT_TYPE] + $headers, $body);
    }

    /**
     * An HTML document.
     *
     * The body is passed through byte for byte: it is the frontend's exported
     * file with two elements rewritten, and re-encoding or reformatting any of it
     * here would only be a way to corrupt a build artifact PHP does not own.
     *
     * `Content-Type` is supplied by the caller from `publicPage.contentType`
     * rather than hard-coded, so the frozen value has one source.
     *
     * @param array<string, string> $headers
     */
    public static function html(int $status, string $body, array $headers = []): self
    {
        return new self($status, $headers, $body);
    }

    /** @param array<string, string> $headers */
    public static function empty(int $status, array $headers = []): self
    {
        return new self($status, $headers, '');
    }

    public function withHeader(string $name, string $value): self
    {
        return new self($this->status, [$name => $value] + $this->headers, $this->body);
    }

    public function header(string $name): ?string
    {
        foreach ($this->headers as $key => $value) {
            if (strcasecmp($key, $name) === 0) {
                return $value;
            }
        }

        return null;
    }

    /** @return array<mixed>|null */
    public function decodedBody(): ?array
    {
        if ($this->body === '') {
            return null;
        }

        /** @var mixed $decoded */
        $decoded = json_decode($this->body, true);

        return \is_array($decoded) ? $decoded : null;
    }

    public function send(): void
    {
        http_response_code($this->status);

        foreach ($this->headers as $name => $value) {
            header("{$name}: {$value}", true);
        }

        if ($this->body !== '') {
            echo $this->body;
        }
    }
}
