<?php

declare(strict_types=1);

namespace Eszter\Tests\Deploy;

use Eszter\Deploy\HtaccessRenderer;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-084 — the response headers the deployment sends.
 *
 * ## Why these are asserted at all
 *
 * Every one of them is a single line in a generated file, which is exactly the
 * kind of thing that disappears in a refactor and is never noticed: nothing breaks
 * when a security header stops being sent. The only signal is a test, or an
 * attacker.
 *
 * ## What this does not prove
 *
 * That Apache applies any of it. The committed `.htaccess` is what the routing
 * table renders, and `DocumentRootRoutingTest` proves the file matches the table
 * byte for byte — but whether the host has `mod_headers`, and whether the plan
 * honours a per-directory `Header always set`, is a property of a deployed origin.
 * `docs/v1-quality-gates.md` keeps `smoke:http` and `security:config` at NOT RUN
 * for that reason and this test does not change it.
 */
final class SecurityHeadersTest extends TestCase
{
    private string $documentRoot;
    private string $media;

    protected function setUp(): void
    {
        $this->documentRoot = HtaccessRenderer::renderDocumentRoot();
        $this->media = HtaccessRenderer::renderMedia();
    }

    public function testTheBaselineHeadersAreSentOnEveryResponse(): void
    {
        $baseline = [
            'X-Content-Type-Options' => '"nosniff"',
            'Referrer-Policy' => '"strict-origin-when-cross-origin"',
            'X-Frame-Options' => '"SAMEORIGIN"',
        ];

        foreach ($baseline as $header => $value) {
            self::assertStringContainsString(
                "Header always set {$header} {$value}",
                $this->documentRoot,
                "{$header} is not sent",
            );
        }

        // `always`, not the default. Without it the header is attached only to
        // 2xx and 3xx responses, so every 404 and every 500 — the responses an
        // attacker sees most of — would go out bare.
        self::assertSame(
            0,
            preg_match('/^\s*Header set /m', $this->documentRoot),
            'a header is set without `always` and will be missing from error responses',
        );
    }

    public function testTheServerIdentifyingHeadersAreRemoved(): void
    {
        self::assertStringContainsString('Header always unset X-Powered-By', $this->documentRoot);
        self::assertStringContainsString('Header always unset Server', $this->documentRoot);
    }

    /**
     * The directives that remain useful even though `script-src` carries
     * `'unsafe-inline'`.
     *
     * `frame-ancestors` controls who may frame Eszter, while `frame-src` controls
     * what Eszter itself may frame. The admin preview needs the latter to allow the
     * same origin; keeping it at `none` made the browser reject `/admin/preview`
     * even though the component and X-Frame-Options were both intentionally
     * same-origin.
     */
    public function testTheContentSecurityPolicyClosesWhatItCan(): void
    {
        $policy = $this->directive('Content-Security-Policy');

        self::assertStringContainsString("default-src 'self'", $policy);
        self::assertStringContainsString("object-src 'none'", $policy);
        self::assertStringContainsString("base-uri 'self'", $policy);
        self::assertStringContainsString("form-action 'self'", $policy);
        self::assertStringContainsString("frame-ancestors 'self'", $policy);
        self::assertStringContainsString("frame-src 'self'", $policy);
        self::assertStringNotContainsString("frame-src 'none'", $policy);

        // The preview may frame this origin and nothing else. No wildcard or named
        // external origin is allowed anywhere in the policy.
        self::assertSame(
            0,
            preg_match('#https?://#', $policy),
            'the policy names an external origin; this site loads no third-party subresource',
        );
        self::assertStringNotContainsString('*', $policy, 'the policy carries a wildcard source');
        self::assertStringNotContainsString("'unsafe-eval'", $policy);
    }

    /**
     * `img-src` is the one directive the ESZ-104 policy deliberately widens,
     * and it is asserted exactly: `'self' https:` and nothing else.
     *
     * `https:` is scheme-wide, not a host allowlist, because the CMS accepts
     * arbitrary HTTPS origins as external media sources — the CSP mirrors the
     * contract instead of maintaining a second list that could drift from it.
     * `http:` is in neither; `data:` was removed with proof of disuse (no
     * image source in the export is a data URI, and the content contract
     * rejects `data:` media), so no current rendering path needs it.
     */
    public function testTheImageSourceIsExactlySelfAndHttps(): void
    {
        $policy = $this->directive('Content-Security-Policy');

        self::assertSame(
            1,
            substr_count($policy, 'img-src'),
            'img-src appears more than once in the policy',
        );

        self::assertSame(
            0,
            preg_match('/(?:^|;)\s*img-src\s+[^;]*data:[^;]*(?:;|$)/', $policy),
            'img-src still admits data: URIs',
        );

        $sources = self::sourcesOf($policy, 'img-src');
        self::assertSame(["'self'", 'https:'], $sources, 'img-src is not exactly \'self\' https:');
    }

    /** @return list<string> */
    private static function sourcesOf(string $policy, string $directiveName): array
    {
        foreach (explode(';', $policy) as $part) {
            $tokens = preg_split('/\s+/', trim($part)) ?: [];
            if (($tokens[0] ?? '') === $directiveName) {
                return \array_slice($tokens, 1);
            }
        }

        self::fail("{$directiveName} is not present in the policy");
    }

    /**
     * The inline allowance is stated rather than hidden.
     *
     * It is real and it is unavoidable while the export emits inline hydration
     * scripts that Apache serves as static files — there is no request in which a
     * nonce could be minted. Asserting it keeps it honest: someone removing the
     * inline scripts should be able to delete the allowance and see this test tell
     * them to, rather than leaving it in place forever because nobody remembered.
     */
    public function testTheInlineAllowanceIsLimitedToScriptAndStyle(): void
    {
        $policy = $this->directive('Content-Security-Policy');

        self::assertStringContainsString("script-src 'self' 'unsafe-inline'", $policy);
        self::assertStringContainsString("style-src 'self' 'unsafe-inline'", $policy);

        // And nowhere else. `img-src`, `connect-src` and `font-src` have no reason
        // to carry it, and an `'unsafe-inline'` that spread would be invisible.
        self::assertSame(
            2,
            substr_count($policy, "'unsafe-inline'"),
            "'unsafe-inline' appears outside script-src and style-src",
        );
    }

    public function testPowerfulFeaturesAreDeniedByDefault(): void
    {
        $policy = $this->directive('Permissions-Policy');

        // The features whose browser default is "allow", so silence grants them.
        foreach (['camera', 'microphone', 'geolocation', 'payment', 'usb', 'display-capture'] as $feature) {
            self::assertStringContainsString("{$feature}=()", $policy, "{$feature} is not denied");
        }
    }

    /**
     * The media directory is the one place a file a *visitor* supplied is served
     * from, so its own headers matter more than the document root's.
     */
    public function testServedMediaIsInertAndNeverSniffed(): void
    {
        self::assertStringContainsString(
            'Header always set X-Content-Type-Options "nosniff"',
            $this->media,
        );

        // A derivative must render, never download-and-run. `inline` also stops a
        // crafted filename from being suggested as a save name.
        self::assertStringContainsString('Header always set Content-Disposition "inline"', $this->media);

        // PHP is not merely unrouted here; the handler is removed.
        self::assertStringContainsString('RemoveHandler .php', $this->media);
        self::assertStringContainsString('RemoveType .php', $this->media);
    }

    /**
     * HSTS stays commented out until a certificate exists, and that is the correct
     * state rather than an unfinished one: a browser remembers HSTS long after the
     * header is withdrawn, so sending it before HTTPS works is an outage nobody can
     * take back. The runbook turns it on at deploy time.
     */
    public function testHstsIsPreparedButNotYetSent(): void
    {
        self::assertStringContainsString('#     Header always set Strict-Transport-Security', $this->documentRoot);
        self::assertSame(
            0,
            preg_match('/^\s*Header always set Strict-Transport-Security/m', $this->documentRoot),
            'HSTS is being sent before a certificate is proved to exist',
        );
    }

    private function directive(string $header): string
    {
        self::assertSame(
            1,
            preg_match('/Header always set ' . preg_quote($header, '/') . ' "([^"]+)"/', $this->documentRoot, $match),
            "{$header} is not sent",
        );

        return $match[1];
    }
}
