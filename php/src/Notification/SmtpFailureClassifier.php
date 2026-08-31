<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Symfony\Component\Mailer\Exception\TransportExceptionInterface;

/** Converts provider exceptions into safe, retry-compatible outcomes. */
final class SmtpFailureClassifier
{
    public function classify(\Throwable $failure): DeliveryException
    {
        if ($failure instanceof DeliveryException) {
            return $failure;
        }

        if ($failure instanceof TransportExceptionInterface) {
            $code = $failure->getCode();
            if ($code >= 500 && $code <= 599) {
                return new PermanentDeliveryException('smtp_rejected');
            }
            if ($code >= 400 && $code <= 499) {
                return new TransientDeliveryException('smtp_transient');
            }
        }

        return new TransientDeliveryException('smtp_transient');
    }
}
