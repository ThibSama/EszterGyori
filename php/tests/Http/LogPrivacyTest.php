<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Contract\StructuralValidator;
use Eszter\Http\Endpoint\PublicBookingCreateEndpoint;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Support\FrozenClock;
use Eszter\Support\Logger;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

final class LogPrivacyTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-log-privacy');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testBookingValidationLogsOnlySchemaAndIssueCount(): void
    {
        $path = $this->root . '/app.log';
        $endpoint = new PublicBookingCreateEndpoint(
            new InMemoryBookingApi(),
            new StructuralValidator(TestEnvironment::artifacts()),
            new Logger($path, 'warn', new FrozenClock('2026-06-13T12:00:00.000Z')),
        );
        $sensitive = [
            'customerName' => 'Recognizable Customer Name',
            'customerEmail' => 'recognizable.customer@example.test',
            'customerPhone' => '+33 6 12 34 56 78',
            'customerNote' => 'Recognizable private free-form message',
        ];

        try {
            $endpoint(new Request('POST', PublicBookingCreateEndpoint::PATH, [], (string) json_encode($sensitive)));
            self::fail('invalid booking body was accepted');
        } catch (HttpException $exception) {
            self::assertSame(400, $exception->status);
        }

        $contents = (string) file_get_contents($path);
        foreach ($sensitive as $value) {
            self::assertStringNotContainsString($value, $contents);
        }
        /** @var array<string, mixed> $event */
        $event = json_decode(trim($contents), true, 512, JSON_THROW_ON_ERROR);
        self::assertSame(['ts', 'level', 'message', 'schema', 'issues'], array_keys($event));
        self::assertIsInt($event['issues']);
    }
}
