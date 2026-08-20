import { PublicSite } from "./components/public-site";
import {
  APPEARANCE_ELEMENT_ID,
  CONTENT_ELEMENT_ID,
  createDefaultAppearanceStyleSheet,
  createDefaultBootstrapEnvelope,
  serializePublicContentBootstrap,
} from "./lib/public-bootstrap";

/**
 * The public page (ESZ-020/021).
 *
 * Statically exported, with no `revalidate` and no server fetch. ISR was a Node
 * behaviour and there is no Node on the target host; `must-revalidate` plus the
 * published ETag replaces it, and both are emitted by PHP rather than by this
 * page (`docs/hetzner-target-architecture.md` §5).
 *
 * What this component contributes to the export is the two elements PHP rewrites
 * at request time. They are baked with the canonical defaults, which makes the
 * exported file a complete, indexable page on its own — that is what the page
 * falls back to when published content cannot be read, and what a crawler sees if
 * it somehow reaches the file directly rather than through PHP.
 */
export default function Home() {
  return (
    <>
      {/*
        Rendered as raw text on purpose. React escapes `<` inside a text child,
        which would corrupt the JSON payload for `JSON.parse`; the escaping that
        keeps this element from being closable is done by
        `serializePublicContentBootstrap`, which encodes the same characters PHP's
        JSON_HEX_* flags do.
      */}
      <script
        id={CONTENT_ELEMENT_ID}
        type="application/json"
        dangerouslySetInnerHTML={{
          __html: serializePublicContentBootstrap(createDefaultBootstrapEnvelope()),
        }}
      />
      <style
        id={APPEARANCE_ELEMENT_ID}
        dangerouslySetInnerHTML={{ __html: createDefaultAppearanceStyleSheet() }}
      />
      <PublicSite />
    </>
  );
}
