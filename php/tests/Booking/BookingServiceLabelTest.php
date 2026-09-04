<?php

declare(strict_types=1);

namespace Eszter\Tests\Booking;

use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingServiceLabelResolver;
use Eszter\Booking\BookingValidationException;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * AUD-14 (ESZ-109): the provisioning label authority.
 *
 * The resolver is the one rule every provisioning entry point (the CLI and the
 * development bootstrap) uses to turn the validated published SiteContent
 * envelope into the label it persists: the title of the unique services item
 * whose `id` is the key — never an operator copy, a draft, the defaults or an
 * existing row. These are pure envelope tests; the persistence half lives in
 * the SQL suite against a real database.
 */
final class BookingServiceLabelTest extends TestCase
{
    private BookingDomainContract $contract;
    private BookingServiceLabelResolver $resolver;

    protected function setUp(): void
    {
        $this->contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());
        $this->resolver = new BookingServiceLabelResolver($this->contract);
    }

    /**
     * @param list<array<string, mixed>> $items
     * @return array<string, mixed>
     */
    private function envelopeWithItems(array $items, ?string $services = null): array
    {
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        /** @var array<string, mixed> $content */
        $content['services']['items'] = $items;

        if ($services === 'none') {
            unset($content['services']);
        } elseif ($services === 'no-items') {
            /** @var array<string, mixed> $content */
            $content['services'] = [];
        }

        return ['schemaVersion' => 1, 'content' => $content];
    }

    /** @return array<int, array{id: string, title: string}> */
    private function canonicalItemsWithTitle(string $id, string $title): array
    {
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        /** @var list<array{id: string, title: string}> $items */
        $items = $content['services']['items'];
        foreach ($items as &$item) {
            if ($item['id'] === $id) {
                $item['title'] = $title;
            }
        }

        return $items;
    }

    public function testResolvesTheTitleOfTheUniquePublishedItem(): void
    {
        $items = $this->canonicalItemsWithTitle('brows', 'Sourcils XXL');
        $label = $this->resolver->resolve('brows', $this->envelopeWithItems($items));

        self::assertSame('Sourcils XXL', $label);
    }

    public function testBoundaryWhitespaceIsTrimmedButTheTitleIsOtherwiseExact(): void
    {
        $items = $this->canonicalItemsWithTitle('lips', '  Lèvres pulpeuses  ');
        $label = $this->resolver->resolve('lips', $this->envelopeWithItems($items));

        self::assertSame('Lèvres pulpeuses', $label);
    }

    public function testAnUnknownKeyIsRefusedBeforeAnyEnvelopeReading(): void
    {
        try {
            $this->resolver->resolve(
                'nails',
                $this->envelopeWithItems($this->canonicalItemsWithTitle('brows', 'Sourcils')),
            );
            self::fail('an unknown service key was resolved to a label');
        } catch (BookingValidationException $exception) {
            self::assertSame('serviceKey', $exception->field);
        }
    }

    public function testAKeyWithNoPublishedItemIsRefused(): void
    {
        $items = $this->canonicalItemsWithTitle('brows', 'Sourcils');
        $items = array_values(array_filter(
            $items,
            static fn (array $item): bool => $item['id'] !== 'brows',
        ));

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('exactly one is required');
        $this->resolver->resolve('brows', $this->envelopeWithItems($items));
    }

    public function testANonUniquePublishedItemIsRefused(): void
    {
        $items = $this->canonicalItemsWithTitle('brows', 'Sourcils');
        $items[] = ['id' => 'brows', 'title' => 'Sourcils bis'];

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('exactly one is required');
        $this->resolver->resolve('brows', $this->envelopeWithItems($items));
    }

    public function testPublishedContentWithoutAServicesListIsRefused(): void
    {
        foreach (['none', 'no-items'] as $shape) {
            try {
                $this->resolver->resolve('brows', $this->envelopeWithItems([], $shape));
                self::fail("published content without services ({$shape}) resolved a label");
            } catch (\RuntimeException $exception) {
                self::assertNotSame('', $exception->getMessage());
            }
        }
    }

    public function testAnUntitledItemIsRefused(): void
    {
        $items = $this->canonicalItemsWithTitle('brows', 'Sourcils');
        foreach ($items as &$item) {
            if ($item['id'] === 'brows') {
                unset($item['title']);
            }
        }

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('no title to persist');
        $this->resolver->resolve('brows', $this->envelopeWithItems($items));
    }

    public function testATitleBeyondTheBookingLabelBoundIsRefused(): void
    {
        $items = $this->canonicalItemsWithTitle('brows', str_repeat('x', $this->contract->labelMaxLength + 1));

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('not a storable booking label');
        $this->resolver->resolve('brows', $this->envelopeWithItems($items));
    }

    public function testTheDomainLabelBoundaryValueIsAccepted(): void
    {
        $items = $this->canonicalItemsWithTitle('brows', str_repeat('x', $this->contract->labelMaxLength));

        self::assertSame(
            str_repeat('x', $this->contract->labelMaxLength),
            $this->resolver->resolve('brows', $this->envelopeWithItems($items)),
        );
    }
}
