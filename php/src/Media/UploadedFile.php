<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * One multipart part, decoupled from `$_FILES`.
 *
 * Same reason {@see \Eszter\Http\Request} is decoupled from `$_SERVER`: the whole
 * ingest has to be exercisable without a web server, and a pipeline that reached
 * for a superglobal could only ever be tested by pretending to be one.
 *
 * The two fields a caller controls — {@see $clientFileName} and
 * {@see $declaredMimeType} — are carried here rather than dropped at the door,
 * and that is deliberate: they are useful in a log line, and keeping them
 * *visible but unused* is what lets a test assert that neither of them influenced
 * the outcome. A field that does not exist cannot be proved not to matter.
 */
final class UploadedFile
{
    public function __construct(
        /** The multipart field name. Only `file` is accepted; see the contract. */
        public readonly string $fieldName,
        /** Where PHP parked the bytes. Never derived from anything the caller sent. */
        public readonly string $temporaryPath,
        public readonly int $size,
        /** A `UPLOAD_ERR_*` constant. */
        public readonly int $errorCode,
        /** Caller-controlled. Logged, never trusted, never used to build a path. */
        public readonly string $clientFileName = '',
        /** Caller-controlled. Logged, never trusted, never used to decide the type. */
        public readonly string $declaredMimeType = '',
    ) {
    }

    /**
     * Reads `$_FILES` into a flat list.
     *
     * PHP's array shape for multiple parts under one name is famously
     * transposed — `$_FILES['file']['name']` becomes an array rather than
     * `$_FILES['file'][0]['name']` — so both shapes are normalised here. The
     * endpoint then refuses anything that is not exactly one part named `file`,
     * which is the check that matters; this method's job is only to make the
     * count knowable.
     *
     * @param array<mixed> $files
     * @return list<self>
     */
    public static function fromPhpFiles(array $files): array
    {
        $uploads = [];

        foreach ($files as $field => $entry) {
            if (!\is_string($field) || !\is_array($entry)) {
                continue;
            }

            /** @var mixed $temporaryName */
            $temporaryName = $entry['tmp_name'] ?? null;

            if (\is_array($temporaryName)) {
                foreach (array_keys($temporaryName) as $index) {
                    $uploads[] = self::one($field, $entry, $index);
                }

                continue;
            }

            $uploads[] = self::one($field, $entry, null);
        }

        return $uploads;
    }

    /**
     * @param array<mixed> $entry
     * @param array-key|null $index
     */
    private static function one(string $field, array $entry, mixed $index): self
    {
        $read = static function (string $key) use ($entry, $index): mixed {
            /** @var mixed $value */
            $value = $entry[$key] ?? null;

            if ($index === null) {
                return $value;
            }

            return \is_array($value) ? ($value[$index] ?? null) : null;
        };

        /** @var mixed $error */
        $error = $read('error');
        /** @var mixed $size */
        $size = $read('size');
        /** @var mixed $temporaryPath */
        $temporaryPath = $read('tmp_name');
        /** @var mixed $name */
        $name = $read('name');
        /** @var mixed $type */
        $type = $read('type');

        return new self(
            $field,
            \is_string($temporaryPath) ? $temporaryPath : '',
            \is_int($size) ? $size : 0,
            \is_int($error) ? $error : \UPLOAD_ERR_NO_FILE,
            \is_string($name) ? $name : '',
            \is_string($type) ? $type : '',
        );
    }
}
