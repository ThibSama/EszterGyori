<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * Base class for the two things a transport is allowed to say when it fails.
 *
 * The code is the only diagnostic that survives into storage and into logs, and
 * it is validated against the frozen pattern before it is written, so a
 * transport cannot smuggle a provider's error string — which routinely contains
 * the recipient address — into either.
 */
abstract class DeliveryException extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message = '')
    {
        parent::__construct($message === '' ? $errorCode : $message);
    }
}
