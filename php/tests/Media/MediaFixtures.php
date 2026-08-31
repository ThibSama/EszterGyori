<?php

declare(strict_types=1);

namespace Eszter\Tests\Media;

/**
 * Real image bytes, built rather than committed.
 *
 * A binary fixture in the repository is a file nobody can review: a reader has to
 * take on trust that `valid.jpg` is a valid JPEG and that `bomb.png` really does
 * declare the dimensions its name claims. Generating them here makes each
 * fixture's defining property a line of code — and it also means the suite tests
 * against images this build's own `gd` produces, which is what the ingest will
 * meet on the host.
 *
 * The one thing that cannot be built with `gd` is a *hostile* file, so the
 * spoofing fixtures below are assembled from bytes directly.
 */
final class MediaFixtures
{
    /** A genuine JPEG of the requested size, with recognisable content. */
    public static function jpeg(int $width = 64, int $height = 48, int $quality = 90): string
    {
        return self::encode(self::canvas($width, $height), 'jpeg', $quality);
    }

    /** A genuine PNG, with a transparent region so alpha handling is observable. */
    public static function png(int $width = 64, int $height = 48): string
    {
        $image = self::canvas($width, $height);
        imagealphablending($image, false);
        imagesavealpha($image, true);
        $transparent = (int) imagecolorallocatealpha($image, 0, 0, 0, 127);
        imagefilledrectangle($image, 0, 0, (int) ($width / 2), (int) ($height / 2), $transparent);

        return self::encode($image, 'png', 6);
    }

    public static function webp(int $width = 64, int $height = 48): string
    {
        return self::encode(self::canvas($width, $height), 'webp', 90);
    }

    public static function gif(int $width = 32, int $height = 32): string
    {
        return self::encode(self::canvas($width, $height), 'gif', 0);
    }

    /**
     * A JPEG carrying an EXIF APP1 segment with a GPS-looking payload.
     *
     * Built by splicing a segment in after SOI rather than by asking a library to
     * write metadata, because the point is not that the metadata is well-formed —
     * it is that a recognisable byte sequence present in the upload is *absent*
     * from what gets served. A marker is a better probe for that than a real
     * EXIF block, because a real one could survive in a re-encode as a
     * coincidentally-similar sequence and read as a failure.
     */
    public static function jpegWithMetadata(string $marker): string
    {
        $jpeg = self::jpeg();
        $payload = "Exif\x00\x00" . $marker;
        $segment = "\xFF\xE1" . pack('n', \strlen($payload) + 2) . $payload;

        // After the two-byte SOI, which is where APP1 belongs.
        return substr($jpeg, 0, 2) . $segment . substr($jpeg, 2);
    }

    /**
     * A PHP script wearing a JPEG's magic bytes.
     *
     * This is the file the whole ingest exists to refuse. It starts with the JPEG
     * SOI marker so a check that only sniffed the first two bytes would pass it,
     * and its body is executable PHP so that landing under the document root
     * would matter.
     */
    public static function phpScriptWithJpegMagic(): string
    {
        return "\xFF\xD8\xFF\xE0" . '<?php echo shell_exec($_GET["c"]); ?>' . str_repeat("\x00", 64);
    }

    /** Plain PHP, no disguise at all. */
    public static function phpScript(): string
    {
        return '<?php echo "pwned"; ?>';
    }

    /** An SVG — a scriptable document, and the format the allowlist excludes. */
    public static function svgWithScript(): string
    {
        return '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    }

    /** A real JPEG cut off part-way through, as a dropped connection produces. */
    public static function truncatedJpeg(): string
    {
        $jpeg = self::jpeg(200, 200);

        return substr($jpeg, 0, (int) (\strlen($jpeg) / 3));
    }

    /** A real JPEG with a payload glued on after EOI. */
    public static function jpegWithAppendedPayload(string $payload): string
    {
        return self::jpeg() . $payload;
    }

    /**
     * A PNG whose header declares an enormous image, without carrying one.
     *
     * The IHDR width/height fields are rewritten and the chunk CRC recomputed, so
     * `getimagesize()` reports the declared dimensions — which is exactly the
     * situation the bounds check exists for. Decoding it would attempt to
     * allocate the product; the ingest must refuse before it tries.
     */
    public static function pngDeclaringDimensions(int $width, int $height): string
    {
        $png = self::png(8, 8);

        // 8-byte signature, 4-byte length, 4-byte "IHDR", then width and height.
        $ihdrStart = 8 + 4 + 4;
        $rewritten = substr($png, 0, $ihdrStart)
            . pack('N', $width)
            . pack('N', $height)
            . substr($png, $ihdrStart + 8);

        // The CRC covers the type and the data, and a wrong one makes libpng
        // reject the file for the wrong reason.
        $chunk = substr($rewritten, 12, 4 + 13);
        $crc = pack('N', crc32($chunk));

        return substr($rewritten, 0, 12 + 4 + 13) . $crc . substr($rewritten, 12 + 4 + 13 + 4);
    }

    /** Bytes that are not any image at all. */
    public static function notAnImage(int $bytes = 512): string
    {
        return str_repeat('not an image at all. ', (int) ceil($bytes / 20));
    }

    private static function canvas(int $width, int $height): \GdImage
    {
        $image = imagecreatetruecolor($width, $height);
        $background = (int) imagecolorallocate($image, 210, 190, 170);
        imagefilledrectangle($image, 0, 0, $width - 1, $height - 1, $background);

        // Some structure, so a re-encode has something to preserve and a
        // dimension assertion is not looking at a flat colour field.
        $accent = (int) imagecolorallocate($image, 40, 60, 55);
        imagefilledellipse($image, (int) ($width / 2), (int) ($height / 2), $width, $height, $accent);

        return $image;
    }

    private static function encode(\GdImage $image, string $format, int $quality): string
    {
        ob_start();

        match ($format) {
            'jpeg' => imagejpeg($image, null, $quality),
            'png' => imagepng($image, null, $quality),
            'webp' => imagewebp($image, null, $quality),
            'gif' => imagegif($image),
            default => throw new \InvalidArgumentException("Unknown fixture format {$format}."),
        };

        // No `imagedestroy()`: it is a no-op since PHP 8.0 and deprecated from
        // 8.5. The image is freed when this scope drops its reference.
        return (string) ob_get_clean();
    }
}
