"use client";

import { useSyncExternalStore } from "react";
import { SitePreview } from "./site-preview";
import {
  readPublicContentBootstrap,
  type PublicContentResult,
} from "../lib/public-bootstrap";
import { defaultSiteContent } from "@eszter/contracts";

/**
 * The public page, rendered from whatever PHP injected (ESZ-021).
 *
 * ## Why `useSyncExternalStore` and not `useEffect`
 *
 * The exported HTML carries the canonical defaults; the DOM the browser actually
 * receives carries the published document, because PHP rewrote the bootstrap
 * element in between. Those two disagree, and React has exactly one sanctioned
 * way to say "the server markup and the client data differ, on purpose":
 * `getServerSnapshot` is used for the hydration pass, `getSnapshot` for every
 * render after it.
 *
 * Hydrating straight from the injected payload would be a hydration mismatch —
 * React 19 recovers by throwing away the server markup and client-rendering the
 * whole tree, which is both an error in the console and the slow path on the one
 * page whose LCP matters. Reading it in `useEffect` would work, but it makes the
 * published content a second render that is invisible to the type system and easy
 * to forget to depend on. This hook is the version React actually intends.
 *
 * The cost is one extra render when published copy differs from the last build,
 * which is a text swap. Colours do *not* participate: they arrive as the
 * PHP-injected `:root` block in `<head>` and are correct on the first paint, so
 * nothing about the page's appearance flickers. See `appearanceSource` on
 * {@link SitePreview}.
 */
const EMPTY_UNSUBSCRIBE = () => {};

/**
 * The payload is a static text node written before the document was parsed; it
 * never changes again. There is nothing to subscribe to, and saying so is
 * cheaper and more honest than a MutationObserver that can never fire.
 */
function subscribe(): () => void {
  return EMPTY_UNSUBSCRIBE;
}

/**
 * Read once and memoised. `useSyncExternalStore` calls `getSnapshot` on every
 * render and bails out only if the result is referentially equal, so parsing the
 * envelope afresh each time would loop forever.
 */
let cachedSnapshot: PublicContentResult | null = null;

function getSnapshot(): PublicContentResult {
  cachedSnapshot ??= readPublicContentBootstrap();
  return cachedSnapshot;
}

/** What `next build` put in the HTML, so the hydration pass matches it exactly. */
const SERVER_SNAPSHOT: PublicContentResult = {
  content: defaultSiteContent,
  source: "defaults",
  revision: null,
  publishedAt: null,
};

function getServerSnapshot(): PublicContentResult {
  return SERVER_SNAPSHOT;
}

export function PublicSite() {
  const result = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return <SitePreview content={result.content} appearanceSource="document" />;
}
