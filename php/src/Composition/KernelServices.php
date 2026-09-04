<?php

declare(strict_types=1);

namespace Eszter\Composition;

use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaLibrary;
use Eszter\Storage\ContentStorage;
use Eszter\Support\Clock;
use Eszter\Support\Logger;

/**
 * The kernel-level services the route-surface composers are built from.
 *
 * {@see \Eszter\Kernel::boot()} constructs each of these once, then hands every
 * composer the same snapshot. The composers exist so the kernel does not have
 * to know the concrete endpoint classes of its own surfaces; this bundle
 * exists so those composers do not each need an eight-parameter constructor.
 *
 * It is a readonly value object, not a container: every property is typed,
 * assigned exactly once by the composition root, and read directly by the
 * classes that need it. There is no lookup by name, no registry and no
 * indirection.
 */
final class KernelServices
{
    public function __construct(
        public readonly ContractArtifacts $artifacts,
        public readonly ContentValidator $validator,
        public readonly StructuralValidator $structural,
        public readonly ContentStorage $storage,
        public readonly MediaContract $media,
        public readonly MediaLibrary $mediaLibrary,
        public readonly Logger $logger,
        public readonly Clock $clock,
    ) {
    }
}
