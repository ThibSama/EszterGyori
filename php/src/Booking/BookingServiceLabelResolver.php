<?php

declare(strict_types=1);

namespace Eszter\Booking;

/**
 * AUD-14 (ESZ-109), narrowed by ESZ-149: the published SiteContent item of a
 * service key as a *seed* for a new catalog row.
 *
 * Until ESZ-149 the published title was the standing authority for the
 * stored booking label. The catalog row is that authority now — the
 * administrator edits the name, description and image in the back-office —
 * so this resolver is consulted only when the operator CLI creates a row and
 * has nothing else to name it with: the published item's title becomes the
 * initial label, its description the initial description and its managed
 * visual the initial image. It never overwrites a row that already exists,
 * and a draft, the canonical defaults or an existing row are still never a
 * source.
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
        $seed = $this->seed($key, $envelope);
        if ($seed === null) {
            throw new \RuntimeException(\sprintf(
                'The published SiteContent holds no services item with id "%s".',
                $key,
            ));
        }

        return $seed['label'];
    }

    /**
     * The editorial seed for one key, or null when the published document
     * holds no item for it (ESZ-149: a key created in the back-office has no
     * CMS item, and that is not a fault).
     *
     * `imageSrc` is the item's visual `src` only when it is a string; the
     * caller decides whether that path is a managed one it can store.
     *
     * @param array<string, mixed> $envelope The validated published envelope.
     * @return array{label: string, description: string, imageSrc: ?string}|null
     * @throws BookingValidationException When the key is malformed.
     * @throws \RuntimeException When the published document is unusable —
     *         no content, no services list, more than one item for the key,
     *         or a title that cannot be stored as the booking label.
     */
    public function seed(string $key, array $envelope): ?array
    {
        if (!$this->contract->acceptsServiceKey($key)) {
            throw new BookingValidationException('serviceKey', 'Malformed service key.');
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

        if ($matches === []) {
            return null;
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

        /** @var mixed $description */
        $description = $matches[0]['description'] ?? '';
        /** @var mixed $visual */
        $visual = $matches[0]['visual'] ?? null;
        /** @var mixed $src */
        $src = \is_array($visual) ? ($visual['src'] ?? null) : null;

        return [
            'label' => $title,
            'description' => \is_string($description)
                ? mb_substr(trim($description), 0, $this->contract->descriptionMaxLength)
                : '',
            'imageSrc' => \is_string($src) && $src !== '' ? $src : null,
        ];
    }
}
