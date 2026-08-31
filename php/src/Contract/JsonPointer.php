<?php

declare(strict_types=1);

namespace Eszter\Contract;

/**
 * RFC 6901 pointers plus the three-operation RFC 6902 subset the parity corpus
 * uses (`replace`, `add`, `remove`).
 *
 * `docs/contract-freeze.md` lists exactly this as what a consumer of
 * `parity-corpus.json` needs; it is pure data handling with no schema knowledge.
 */
final class JsonPointer
{
    /** @return list<string> */
    public static function parse(string $pointer): array
    {
        if ($pointer === '') {
            return [];
        }

        if (!str_starts_with($pointer, '/')) {
            throw new \InvalidArgumentException("Invalid JSON Pointer: {$pointer}");
        }

        return array_map(
            static fn (string $token): string => str_replace(['~1', '~0'], ['/', '~'], $token),
            explode('/', substr($pointer, 1)),
        );
    }

    /** @param list<string|int> $tokens */
    public static function compile(array $tokens): string
    {
        if ($tokens === []) {
            return '';
        }

        return '/' . implode('/', array_map(
            static fn (string|int $token): string => str_replace(
                ['~', '/'],
                ['~0', '~1'],
                (string) $token,
            ),
            $tokens,
        ));
    }

    /** Returns null when the pointer does not resolve. */
    public static function resolve(mixed $document, string $pointer): mixed
    {
        $current = $document;

        foreach (self::parse($pointer) as $token) {
            if (!\is_array($current) || !\array_key_exists($token, $current)) {
                return null;
            }
            $current = $current[$token];
        }

        return $current;
    }

    /**
     * Applies the corpus patch subset, returning the new document.
     *
     * @param list<array{op: string, path: string, value?: mixed}> $operations
     */
    public static function applyPatch(mixed $document, array $operations): mixed
    {
        foreach ($operations as $operation) {
            $tokens = self::parse($operation['path']);

            if ($tokens === []) {
                if ($operation['op'] === 'remove') {
                    throw new \InvalidArgumentException('Cannot remove the document root.');
                }
                $document = $operation['value'] ?? null;
                continue;
            }

            self::applyAt($document, $tokens, $operation);
        }

        return $document;
    }

    /**
     * @param list<string> $tokens
     * @param array{op: string, path: string, value?: mixed} $operation
     */
    private static function applyAt(mixed &$document, array $tokens, array $operation): void
    {
        $cursor = &$document;

        foreach (\array_slice($tokens, 0, -1) as $token) {
            if (!\is_array($cursor) || !\array_key_exists($token, $cursor)) {
                throw new \InvalidArgumentException(
                    "Unresolvable pointer segment in {$operation['path']}",
                );
            }
            $cursor = &$cursor[$token];
        }

        if (!\is_array($cursor)) {
            throw new \InvalidArgumentException("Unresolvable parent for {$operation['path']}");
        }

        $leaf = $tokens[\count($tokens) - 1];
        $isList = array_is_list($cursor) && $cursor !== [];

        if ($operation['op'] === 'remove') {
            unset($cursor[$leaf]);
            if ($isList) {
                $cursor = array_values($cursor);
            }
            return;
        }

        $cursor[$leaf] = $operation['value'] ?? null;
    }
}
