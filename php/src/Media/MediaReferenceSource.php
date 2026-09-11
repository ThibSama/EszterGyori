<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * A store, other than the content documents, that can hold a durable
 * reference to a managed media asset (ESZ-149).
 *
 * The delete reference check (`AdminMediaDeleteEndpoint`) walks the draft
 * and the published document; the service catalog (`booking_services
 * .image_src`) is a second place a public path can be pointed at from, and
 * deleting the bytes behind it would break every service thumbnail and the
 * reservation page at once. Each such store answers this one question, and
 * the delete refuses when any of them says yes.
 *
 * Implementations are consulted inside the delete's exclusive media/content
 * boundary; they read and never write.
 */
interface MediaReferenceSource
{
    /** Whether this store holds a reference to `$publicPath`. */
    public function references(string $publicPath): bool;
}
