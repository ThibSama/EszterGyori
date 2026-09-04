<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * AUD-14 (ESZ-109): the single authority for a stored booking label.
 *
 * The booking label is an editorial fact, so its authority lives in the CMS:
 * the *published* SiteContent services item whose `id` is the service key.
 * Provisioning stores exactly that item's title (trimmed of boundary
 * whitespace only) and re-provisioning after a published title change
 * refreshes the stored copy. An operator-supplied label, a draft, the
 * canonical defaults or a pre-existing row are never an authority.
 *
 * The envelope passed to {@see resolve()} must already be the validated
 * published envelope — callers obtain it through the configured
 * content-storage/contract-validation path ({@see \Eszter\Storage\ContentStorage::readPublished()}
 * or the {@see \Eszter\Storage\PublishedContentReader} seam) — so a refusal
 * here means the *published document itself* cannot name the service, and it
 * happens before any `booking_services` row is touched.
 */
final class BookingServiceLabelResolver
{
    public function __construct(private readonly BookingDomainContract $contract)
    {
    }

    /**
     * The authoritative title for one service key, or a refusal.
     *
     * @param array<string, mixed> $envelope The validated published envelope.
     * @throws BookingValidationException When the key is not a canonical
     *         service key.
     * @throws \RuntimeException When the published document is unusable —
     *         no content, no services list, no unique item for the key, or a
     *         title that cannot be stored as the booking label.
     */
    public function resolve(string $key, array $envelope): string
    {
        if (!$this->contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Unknown canonical service key.');
        }

        $content = $envelope['content'] ?? null;
        if (!\is_array($content)) {
            throw new \RuntimeException('The published SiteContent carries no content document.');
        }

        $services = $content['services'] ?? null;
        if (!\is_array($services) || !\is_array($services['items'] ?? null)) {
            throw new \RuntimeException('The published SiteContent carries no services list.');
        }

        $matches = [];
        foreach ($services['items'] as $item) {
            if (\is_array($item) && ($item['id'] ?? null) === $key) {
                $matches[] = $item;
            }
        }

        if (\count($matches) !== 1) {
            throw new \RuntimeException(\sprintf(
                'The published SiteContent holds %d services item(s) with id "%s"; exactly one is required.',
                \count($matches),
                $key,
            ));
        }

        /** @var mixed $title */
        $title = $matches[0]['title'] ?? null;
        if (!\is_string($title)) {
            throw new \RuntimeException(\sprintf(
                'The published SiteContent item "%s" carries no title to persist.',
                $key,
            ));
        }

        $title = trim($title);
        if ($title === '' || mb_strlen($title) > $this->contract->labelMaxLength) {
            throw new \RuntimeException(\sprintf(
                'The published title for service key "%s" is not a storable booking label'
                . ' (1 to %d characters after trimming).',
                $key,
                $this->contract->labelMaxLength,
            ));
        }

        return $title;
    }
}
