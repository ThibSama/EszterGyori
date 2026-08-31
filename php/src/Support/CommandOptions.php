<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * The `--name=value` parser the operator commands share (ESZ-083).
 *
 * Lifted out of `bin/` rather than copied a sixth time: the same private function
 * already existed in `migrate.php`, `provision-admin.php`,
 * `provision-booking-service.php` and `run-notification-jobs.php`, and the backup
 * pair would have made six. It lives in `src/` so it is one class rather than one
 * function declared in several files, which is what a namespaced function in `bin/`
 * would have been.
 *
 * Deliberately not a general option parser. No short flags, no clustering, no `--`
 * terminator, no positional arguments, and an unknown option is simply collected
 * rather than interpreted. Every convenience omitted here is a way for a flag to
 * be produced by something other than someone typing it in full — and two of the
 * commands that use this destroy data on a flag.
 */
final class CommandOptions
{
    /** @param array<string, string|true> $values */
    private function __construct(private readonly array $values)
    {
    }

    /** @param list<string> $argv The raw `$argv`, program name included. */
    public static function parse(array $argv): self
    {
        $values = [];

        foreach (\array_slice($argv, 1) as $argument) {
            if (!str_starts_with($argument, '--')) {
                continue;
            }

            $body = substr($argument, 2);
            $equals = strpos($body, '=');

            if ($equals === false) {
                $values[$body] = true;
                continue;
            }

            $values[substr($body, 0, $equals)] = substr($body, $equals + 1);
        }

        return new self($values);
    }

    /** True only for a bare `--name`, never for `--name=anything`. */
    public function flag(string $name): bool
    {
        return ($this->values[$name] ?? null) === true;
    }

    /** The value of `--name=value`, or null when it was absent or bare. */
    public function value(string $name): ?string
    {
        $value = $this->values[$name] ?? null;

        return \is_string($value) && $value !== '' ? $value : null;
    }
}
