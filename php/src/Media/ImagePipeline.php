<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * Type detection, bounds checking, decoding and re-encoding (ESZ-036).
 *
 * Everything that touches image bytes lives here, behind four small methods, so
 * that the endpoint reads as the pipeline the contract froze rather than as a
 * sequence of `gd` calls.
 *
 * ## Two independent verifications, not one repeated
 *
 * {@see detectMimeType()} reads magic bytes through `finfo`. {@see inspect()}
 * parses the image header through `getimagesize()`. They are different parsers
 * looking at different parts of the file, and the ingest requires them to
 * **agree**. A polyglot — a file that is a valid GIF to one and a valid something
 * else to the other — fails that comparison instead of being resolved in favour
 * of whichever check happens to run last.
 *
 * ## Why re-encode at all
 *
 * Because it converts a security argument into a mechanical one. After a decode
 * and a re-encode, the served bytes are this process's output: whatever was
 * appended to the upload after its image data — a PHP payload, a polyglot's
 * second half, a comment block full of script — is not in them, because nothing
 * copied it. EXIF goes the same way, which means a photograph's GPS coordinates
 * stop being published as a side effect of the ordinary path rather than through
 * a stripping step someone has to remember to call.
 *
 * The cost is one lossy round-trip for JPEG and WebP. At quality 88 that is
 * invisible at the sizes this site renders, and the original is kept so a better
 * derivative can be produced later without asking the editor for the file again.
 *
 * ## Bounds before decode
 *
 * {@see inspect()} runs before {@see reencode()}, and the ingest refuses on its
 * numbers. That ordering is the whole defence against a decompression bomb: a
 * 40 kB PNG can describe a 30 GB bitmap, and there is no way to survive decoding
 * one — only ways to avoid it.
 */
final class ImagePipeline
{
    /**
     * JPEG/WebP encoder quality.
     *
     * 88 rather than the library defaults (75 for JPEG, 80 for WebP): the
     * material is close-up photographs of skin, where 75 shows visible blocking
     * in smooth gradients. Above ~90 the file grows fast for no visible gain.
     */
    public const QUALITY = 88;

    /**
     * PNG compression level, 0–9. 6 is `zlib`'s default trade-off; 9 costs
     * several times the CPU for a low single-digit percentage of size on
     * photographic content.
     */
    public const PNG_COMPRESSION = 6;

    /**
     * How far back from the end of a file the terminator may sit.
     *
     * 64 kB is generous for the trailing junk a camera appends and small enough
     * that a file which is mostly junk with an image bolted on the front is
     * refused. It also bounds the read: this runs on hostile input.
     */
    public const TERMINATOR_WINDOW_BYTES = 65536;

    public function __construct(private readonly MediaContract $contract)
    {
    }

    /**
     * Refuses to run at all on a host that cannot verify an image.
     *
     * Called before a byte is read, so a misconfigured host answers 500
     * INVALID_CONFIGURATION rather than storing something it could not check. The
     * format loop matters as much as the extension check: `gd` compiled without
     * WebP is present, loads, and silently cannot decode a third of the
     * allowlist.
     *
     * @throws MediaConfigurationException
     */
    public function assertAvailable(): void
    {
        if (!\function_exists('finfo_open')) {
            throw new MediaConfigurationException(
                'The fileinfo extension is not loaded, so an upload cannot be typed from its '
                . 'bytes. Enable ext-fileinfo.',
            );
        }

        if (!\function_exists('getimagesize') || !\extension_loaded('gd')) {
            throw new MediaConfigurationException(
                'The gd extension is not loaded, so an upload cannot be decoded or re-encoded. '
                . 'Enable ext-gd.',
            );
        }

        /** @var array<string, mixed> $info */
        $info = gd_info();

        foreach ($this->contract->mimeTypes() as $mimeType) {
            $key = match ($mimeType) {
                'image/jpeg' => 'JPEG Support',
                'image/png' => 'PNG Support',
                'image/webp' => 'WebP Support',
                default => null,
            };

            if ($key === null) {
                throw new MediaConfigurationException(
                    "The contract allows {$mimeType}, which this build cannot decode.",
                );
            }

            if (($info[$key] ?? false) !== true) {
                throw new MediaConfigurationException(
                    "gd is loaded without {$key}, so {$mimeType} could not be verified.",
                );
            }
        }
    }

    /**
     * The media type of the bytes at $path, or null when they are not typeable.
     *
     * `FILEINFO_MIME_TYPE` only: the full `finfo` string carries a charset
     * parameter, and comparing `image/jpeg; charset=binary` against an allowlist
     * of bare types is the kind of near-miss that is fixed by loosening the
     * comparison and thereby loosening the allowlist.
     */
    public function detectMimeType(string $path): ?string
    {
        $finfo = @finfo_open(\FILEINFO_MIME_TYPE);

        if ($finfo === false) {
            return null;
        }

        // No `finfo_close()`. It is deprecated from PHP 8.5 — the handle is an
        // object freed by refcounting — and calling it would make this file emit
        // a deprecation on the newest runtime while being unnecessary on every
        // older one this project supports.
        $detected = @finfo_file($finfo, $path);

        return \is_string($detected) && $detected !== '' ? $detected : null;
    }

    /**
     * Header-level dimensions and type, without decoding the image.
     *
     * @return array{width: int, height: int, mimeType: string}|null
     */
    public function inspect(string $path): ?array
    {
        $size = @getimagesize($path);

        if ($size === false) {
            return null;
        }

        $width = $size[0];
        $height = $size[1];
        $mimeType = $size['mime'];

        // A zero dimension is what `getimagesize()` reports for a header it
        // parsed but cannot make sense of. It is not an image, and every bound
        // below would be vacuously satisfied by it.
        if ($width < 1 || $height < 1 || $mimeType === '') {
            return null;
        }

        return ['width' => $width, 'height' => $height, 'mimeType' => $mimeType];
    }

    /**
     * Whether a header's dimensions are within the frozen bounds.
     *
     * The pixel product is checked as a float, deliberately. Two `int`s near the
     * per-side maximum multiply to about 6.4 × 10^7, which is nowhere near
     * overflowing on a 64-bit build — but this check exists to bound a hostile
     * input, and a bound that is only correct because the inputs are small is not
     * a bound.
     *
     * @param array{width: int, height: int, mimeType: string} $header
     */
    public function isWithinBounds(array $header): bool
    {
        if (
            $header['width'] < $this->contract->minDimension
            || $header['height'] < $this->contract->minDimension
            || $header['width'] > $this->contract->maxDimension
            || $header['height'] > $this->contract->maxDimension
        ) {
            return false;
        }

        return (float) $header['width'] * (float) $header['height']
            <= (float) $this->contract->maxPixels;
    }

    /**
     * Whether the file carries its format's end-of-stream marker.
     *
     * This is the truncation check, and it exists because the obvious place to
     * put one does not work: decoders are lenient by design. `libjpeg`'s error
     * recovery turns a JPEG cut off mid-transfer into a complete image with grey
     * filler and reports *nothing* — not a warning, not a false return — so
     * asking `imagecreatefromjpeg()` whether a transfer completed gets a
     * confident yes. The question has to be asked of the bytes instead.
     *
     * Present, not last. Bytes after the terminator are left alone: re-encoding
     * has already made them unreachable, they are what a polyglot's second half
     * would be and it does not survive the pipeline anyway, and real cameras
     * append them. Requiring the terminator to be the final bytes would refuse
     * photographs for a property that stopped mattering two steps ago.
     *
     * The scan is bounded to the tail of the file rather than reading all of it:
     * a terminator arbitrarily far from the end would mean the file is mostly
     * trailing junk, which is not something to accommodate.
     */
    public function isStreamComplete(string $path, string $mimeType): bool
    {
        $size = @filesize($path);

        if ($size === false || $size < 12) {
            return false;
        }

        if ($mimeType === 'image/webp') {
            // RIFF declares its own payload length in bytes 4..7, little-endian,
            // counting everything after that field. A file shorter than it claims
            // was cut off.
            $header = (string) @file_get_contents($path, false, null, 0, 12);

            if (\strlen($header) < 12 || substr($header, 0, 4) !== 'RIFF') {
                return false;
            }

            /** @var array{1: int}|false $declared */
            $declared = unpack('V', substr($header, 4, 4));

            return $declared !== false && $declared[1] + 8 <= $size;
        }

        $window = min($size, self::TERMINATOR_WINDOW_BYTES);
        $tail = (string) @file_get_contents($path, false, null, $size - $window, $window);

        $terminator = match ($mimeType) {
            // EOI.
            'image/jpeg' => "\xFF\xD9",
            // The IEND chunk, whose contents are empty and whose CRC is fixed.
            'image/png' => "IEND\xAE\x42\x60\x82",
            default => null,
        };

        if ($terminator === null) {
            // Unreachable: the allowlist has three entries and all three are
            // handled. Stated as a refusal rather than an acceptance, because the
            // safe answer for a format whose end nobody taught this method to
            // find is "cannot confirm", not "looks fine".
            return false;
        }

        return str_contains($tail, $terminator);
    }

    /**
     * Decodes $sourcePath and writes the canonical encoding of its type to
     * $destinationPath.
     *
     * The source type is the **verified** one, so the decoder is chosen from what
     * the bytes are rather than from what they are named. A file that reaches
     * here and still fails to decode is refused: it satisfied both header checks
     * and is still not an image, which is exactly the case the two header checks
     * cannot catch on their own.
     *
     * PNG alpha is preserved explicitly. `imagecreatefrompng()` gives a truecolour
     * image whose alpha channel `imagepng()` discards unless saving is turned on,
     * so without these two calls every transparent PNG would come back with a
     * black background — a silent, visible content bug rather than a failure.
     *
     * @return array{width: int, height: int}
     * @throws MediaException When the bytes will not decode or will not re-encode.
     */
    public function reencode(string $sourcePath, string $mimeType, string $destinationPath): array
    {
        $image = match ($mimeType) {
            'image/jpeg' => @imagecreatefromjpeg($sourcePath),
            'image/png' => @imagecreatefrompng($sourcePath),
            'image/webp' => @imagecreatefromwebp($sourcePath),
            default => false,
        };

        if ($image === false) {
            throw MediaException::rejected(
                "A file typed as {$mimeType} could not be decoded as one.",
            );
        }

        try {
            if ($mimeType === 'image/png') {
                imagealphablending($image, false);
                imagesavealpha($image, true);
            }

            $written = match ($mimeType) {
                'image/jpeg' => @imagejpeg($image, $destinationPath, self::QUALITY),
                'image/png' => @imagepng($image, $destinationPath, self::PNG_COMPRESSION),
                'image/webp' => @imagewebp($image, $destinationPath, self::QUALITY),
                default => false,
            };

            if ($written !== true) {
                throw MediaException::rejected(
                    "A decoded {$mimeType} image could not be re-encoded.",
                );
            }

            return ['width' => imagesx($image), 'height' => imagesy($image)];
        } finally {
            // No `imagedestroy()`. A `GdImage` has been a refcounted object since
            // PHP 8.0, so the call has had no effect for five versions and is
            // deprecated from 8.5. Dropping the reference is what frees it, and
            // that happens when this scope ends.
            unset($image);
        }
    }
}
