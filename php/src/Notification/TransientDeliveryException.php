<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * The delivery might succeed later: a timeout, an SMTP 4xx, a rate limit.
 *
 * Retried with bounded backoff until the attempt budget is spent, at which point
 * it becomes terminal `failed` rather than being retried forever.
 */
final class TransientDeliveryException extends DeliveryException
{
}
