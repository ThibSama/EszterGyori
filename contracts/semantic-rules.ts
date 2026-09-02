/**
 * Registry of validation semantics that survive in Zod but NOT in JSON Schema
 * (ESZ-003).
 *
 * JSON Schema generated from these Zod schemas keeps structure, strictness,
 * enums, string patterns and array lengths. It silently drops every
 * `.refine`/`.superRefine`/`.transform`, which is where most of this project's
 * real invariants live: fixed technical ids, positional ordering, WCAG contrast
 * floors, URL protocol/host restrictions and hex normalization.
 *
 * Each rule below is therefore paired with executable parity cases. The cases
 * are expressed as a shared base document plus a JSON Pointer patch, so a PHP
 * implementation can replay the exact same corpus with no Node runtime and no
 * second hand-maintained schema.
 *
 * Adding a Zod refinement without adding a rule here fails
 * `contracts/tests/parity-coverage.test.ts`.
 */

/** Documents a parity case can be built from. */
export type ParityTarget = "siteContent" | "publishedEnvelope";

/** Minimal RFC 6902 subset. Enough to express every case, trivial to port. */
export type ParityPatchOperation =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

export interface ParityCase {
  /** Stable identifier, safe to reference from a PHP test suite. */
  id: string;
  /** Rule this case exercises. */
  rule: string;
  /** Whether the patched document must validate. */
  expect: "valid" | "invalid";
  target: ParityTarget;
  description: string;
  patch: ParityPatchOperation[];
  /**
   * JSON Pointer paths of the issues the validator must report, for `invalid`
   * cases. Order-independent; the set must match exactly.
   */
  expectedIssuePaths?: string[];
  /**
   * For `valid` cases that normalize their input: JSON Pointer -> expected
   * value after validation. Empty when parsing is expected to be identity.
   */
  expectedNormalization?: Record<string, unknown>;
}

export interface SemanticRule {
  id: string;
  /** Where the rule lives in the Zod sources. */
  source: string;
  /** Why JSON Schema cannot carry it. */
  lostBecause: string;
  description: string;
}

export const semanticRules: SemanticRule[] = [
  {
    id: "envelope.isoTimestampRoundTrip",
    source: "content-envelopes.ts:isoTimestampSchema",
    lostBecause:
      "A `.refine` comparing Date.parse round-trip output; JSON Schema `format: date-time` is both weaker and annotation-only.",
    description:
      "Timestamps must be exactly the ISO 8601 form produced by Date#toISOString (UTC, milliseconds, trailing Z).",
  },
  {
    id: "appearance.contrastTextOnBackground",
    source: "appearance.ts:siteAppearanceSchema.superRefine",
    lostBecause: "Cross-field WCAG computation; JSON Schema has no arithmetic.",
    description:
      "palette.text must reach a 4.5:1 contrast ratio against palette.background.",
  },
  {
    id: "appearance.contrastTextOnSurface",
    source: "appearance.ts:siteAppearanceSchema.superRefine",
    lostBecause: "Cross-field WCAG computation; JSON Schema has no arithmetic.",
    description:
      "palette.text must reach a 4.5:1 contrast ratio against palette.surface.",
  },
  {
    id: "appearance.contrastMutedTextOnBackground",
    source: "appearance.ts:siteAppearanceSchema.superRefine",
    lostBecause: "Cross-field WCAG computation; JSON Schema has no arithmetic.",
    description:
      "palette.mutedText must reach a 3:1 contrast ratio against palette.background.",
  },
  {
    id: "appearance.hexUppercaseNormalization",
    source: "appearance.ts:hexColorSchema.transform",
    lostBecause:
      "A `.transform`; JSON Schema describes accepted values, never rewrites them.",
    description:
      "Lowercase hex input is accepted and normalized to uppercase #RRGGBB on output.",
  },
  {
    id: "appearance.defaultInjectionForLegacyContent",
    source: "site-content.ts:siteContentSchema.appearance.optional().default()",
    lostBecause:
      "JSON Schema `default` is an annotation, not an applicator; validators do not inject it.",
    description:
      "Content without `appearance` stays valid and is normalized in memory with defaultSiteAppearance.",
  },
  {
    id: "navigation.linkIdOrder",
    source: "site-content.ts:navigationContentSchema.links.superRefine",
    lostBecause: "Positional identity across an array; not expressible generically.",
    description: "navigation.links ids must equal navigationLinkIds, in order.",
  },
  {
    id: "reassurance.itemIdOrder",
    source: "site-content.ts:reassuranceContentSchema.items.superRefine",
    lostBecause: "Positional identity across an array.",
    description: "reassurance.items ids must equal reassuranceItemIds, in order.",
  },
  {
    id: "services.itemIdOrder",
    source: "site-content.ts:servicesContentSchema.items.superRefine",
    lostBecause: "Positional identity across an array.",
    description:
      "services.items ids must equal serviceItemIds, in order. Sibling checks are keyed on the expected id for the position, not on the submitted id.",
  },
  {
    id: "services.visualKindMatchesId",
    source: "site-content.ts:servicesContentSchema.items.superRefine",
    lostBecause: "Cross-field equality inside an array element.",
    description: "Each service item's visualKind must equal its id.",
  },
  {
    id: "services.visualIdMatchesId",
    source: "site-content.ts:servicesContentSchema.items.superRefine",
    lostBecause: "Lookup against an out-of-band id map.",
    description:
      "Each service item's visual.id must be the placeholder media id bound to its item id.",
  },
  {
    id: "process.stepIdOrder",
    source: "site-content.ts:processContentSchema.steps.superRefine",
    lostBecause: "Positional identity across an array.",
    description: "process.steps ids must equal processStepIds, in order.",
  },
  {
    id: "process.stepNumberOrder",
    source: "site-content.ts:processContentSchema.steps.superRefine",
    lostBecause: "Positional identity across an array.",
    description: "process.steps numbers must equal processStepNumbers, in order.",
  },
  {
    id: "gallery.itemIdOrder",
    source: "site-content.ts:galleryContentSchema.items.superRefine",
    lostBecause: "Positional identity across an array.",
    description:
      "gallery.items ids must equal galleryItemIds, in order. Sibling checks are keyed on the expected id for the position, not on the submitted id.",
  },
  {
    id: "gallery.visualKindMatchesId",
    source: "site-content.ts:galleryContentSchema.items.superRefine",
    lostBecause: "Lookup against an out-of-band id map.",
    description:
      "Each gallery item's visualKind must be the kind bound to its item id.",
  },
  {
    id: "gallery.visualIdMatchesId",
    source: "site-content.ts:galleryContentSchema.items.superRefine",
    lostBecause: "Lookup against an out-of-band id map.",
    description:
      "Each gallery item's visual.id must be the placeholder media id bound to its item id.",
  },
  {
    id: "gallery.featuredOnlyFirstItem",
    source: "site-content.ts:galleryContentSchema.items.superRefine",
    lostBecause: "Index-dependent presence requirement.",
    description:
      "Only the first gallery item carries `featured: true`; the others must omit the field entirely.",
  },
  {
    id: "gallery.instagramCtaFixedId",
    source: "site-content.ts:galleryContentSchema.instagramCta.superRefine",
    lostBecause: "`.superRefine` on a reused link object schema.",
    description: "gallery.instagramCta.id is the fixed id `instagram-more`.",
  },
  {
    id: "hero.fixedLinkAndMediaIds",
    source: "site-content.ts:heroContentSchema.superRefine",
    lostBecause:
      "`.superRefine` on an object reused elsewhere; the base object schema stays generic.",
    description:
      "hero.primaryCta.id, hero.secondaryCta.id and hero.visual.id are fixed technical ids.",
  },
  {
    id: "about.portraitFixedId",
    source: "site-content.ts:aboutContentSchema.portrait.superRefine",
    lostBecause: "`.superRefine` on a reused media object schema.",
    description: "about.portrait.id is a fixed technical id.",
  },
  {
    id: "contact.fixedLinkIds",
    source: "site-content.ts:contactContentSchema.superRefine",
    lostBecause: "`.superRefine` on reused link object schemas.",
    description: "contact.instagramCta.id and contact.emailCta.id are fixed ids.",
  },
  {
    id: "footer.linkIdOrder",
    source: "site-content.ts:footerContentSchema.links.superRefine",
    lostBecause: "Positional identity across a heterogeneous union array.",
    description: "footer.links ids must be exactly ['instagram', 'contact'], in order.",
  },
  {
    id: "links.mailtoHref",
    source: "site-content.ts:mailtoHrefSchema",
    lostBecause:
      "A `.refine` combining a prefix check with e-mail parsing; JSON Schema `format` is annotation-only.",
    description:
      "mailto links must start with `mailto:` and carry a parseable e-mail address.",
  },
  {
    id: "links.instagramHttpsHost",
    source: "site-content.ts:instagramUrlSchema",
    lostBecause: "URL parsing plus protocol and hostname restriction.",
    description:
      "Instagram links must be HTTPS URLs on instagram.com or one of its subdomains.",
  },
  {
    id: "media.sourceProtocol",
    source: "site-content.ts:mediaSourceSchema",
    lostBecause:
      "The shared httpsUrlSchema restricts the external-URL branch to https after parsing; `format: uri` does not. The URL policy lives in one schema reused by Instagram links and media sources alike.",
    description:
      "Media sources are a rooted public path, an HTTPS URL, or null; http: and every other protocol are rejected.",
  },
];

const LOWERCASE_PALETTE = {
  background: "#f5f4f1",
  surface: "#fafaf8",
  text: "#2c2b28",
  mutedText: "#6d6b67",
  primary: "#63726c",
  secondary: "#a8aeb8",
  warmAccent: "#d3d1cd",
};

export const parityCases: ParityCase[] = [
  // -- envelope.isoTimestampRoundTrip ------------------------------------
  {
    id: "envelope.isoTimestampRoundTrip.valid",
    rule: "envelope.isoTimestampRoundTrip",
    expect: "valid",
    target: "publishedEnvelope",
    description: "A canonical UTC millisecond timestamp is accepted.",
    patch: [{ op: "replace", path: "/publishedAt", value: "2025-01-02T03:04:05.678Z" }],
  },
  {
    id: "envelope.isoTimestampRoundTrip.offsetRejected",
    rule: "envelope.isoTimestampRoundTrip",
    expect: "invalid",
    target: "publishedEnvelope",
    description:
      "A valid ISO 8601 value with a numeric offset does not round-trip and is rejected.",
    patch: [{ op: "replace", path: "/publishedAt", value: "2026-06-13T14:00:00.000+02:00" }],
    expectedIssuePaths: ["/publishedAt"],
  },
  {
    id: "envelope.isoTimestampRoundTrip.secondsPrecisionRejected",
    rule: "envelope.isoTimestampRoundTrip",
    expect: "invalid",
    target: "publishedEnvelope",
    description: "Second-precision timestamps do not round-trip and are rejected.",
    patch: [{ op: "replace", path: "/publishedAt", value: "2026-06-13T12:00:00Z" }],
    expectedIssuePaths: ["/publishedAt"],
  },
  {
    id: "envelope.isoTimestampRoundTrip.nonDateRejected",
    rule: "envelope.isoTimestampRoundTrip",
    expect: "invalid",
    target: "publishedEnvelope",
    description: "A non-date string is rejected.",
    patch: [{ op: "replace", path: "/publishedAt", value: "not-a-date" }],
    expectedIssuePaths: ["/publishedAt"],
  },

  // -- appearance contrast ----------------------------------------------
  {
    id: "appearance.contrastTextOnBackground.invalid",
    rule: "appearance.contrastTextOnBackground",
    expect: "invalid",
    target: "siteContent",
    description:
      "Near-white primary text on the light background falls under 4.5:1 and is rejected.",
    patch: [{ op: "replace", path: "/appearance/palette/text", value: "#EFEFEF" }],
    expectedIssuePaths: [
      "/appearance/palette/text",
      "/appearance/palette/text",
    ],
  },
  {
    id: "appearance.contrastTextOnBackground.valid",
    rule: "appearance.contrastTextOnBackground",
    expect: "valid",
    target: "siteContent",
    description: "A dark primary text colour clears both 4.5:1 floors.",
    patch: [{ op: "replace", path: "/appearance/palette/text", value: "#1A1A1A" }],
  },
  {
    id: "appearance.contrastTextOnSurface.invalid",
    rule: "appearance.contrastTextOnSurface",
    expect: "invalid",
    target: "siteContent",
    description:
      "Raising the surface to match the text colour breaks the text-on-surface floor.",
    patch: [{ op: "replace", path: "/appearance/palette/surface", value: "#2C2B28" }],
    expectedIssuePaths: ["/appearance/palette/text"],
  },
  {
    id: "appearance.contrastMutedTextOnBackground.invalid",
    rule: "appearance.contrastMutedTextOnBackground",
    expect: "invalid",
    target: "siteContent",
    description: "Muted text too close to the background falls under 3:1.",
    patch: [{ op: "replace", path: "/appearance/palette/mutedText", value: "#E8E7E4" }],
    expectedIssuePaths: ["/appearance/palette/mutedText"],
  },
  {
    id: "appearance.contrastMutedTextOnBackground.valid",
    rule: "appearance.contrastMutedTextOnBackground",
    expect: "valid",
    target: "siteContent",
    description: "A darker muted text colour clears 3:1.",
    patch: [{ op: "replace", path: "/appearance/palette/mutedText", value: "#5A5854" }],
  },

  // -- appearance normalization -----------------------------------------
  {
    id: "appearance.hexUppercaseNormalization.valid",
    rule: "appearance.hexUppercaseNormalization",
    expect: "valid",
    target: "siteContent",
    description: "A fully lowercase palette is accepted and normalized to uppercase.",
    patch: [{ op: "replace", path: "/appearance/palette", value: LOWERCASE_PALETTE }],
    expectedNormalization: {
      "/appearance/palette/background": "#F5F4F1",
      "/appearance/palette/text": "#2C2B28",
      "/appearance/palette/warmAccent": "#D3D1CD",
    },
  },
  {
    id: "appearance.defaultInjectionForLegacyContent.valid",
    rule: "appearance.defaultInjectionForLegacyContent",
    expect: "valid",
    target: "siteContent",
    description:
      "Legacy content without `appearance` validates and receives the default appearance.",
    patch: [{ op: "remove", path: "/appearance" }],
    expectedNormalization: {
      "/appearance/palette/background": "#F5F4F1",
      "/appearance/sectionTints/hero": "#DBE0DD",
    },
  },

  // -- positional id rules ----------------------------------------------
  {
    id: "navigation.linkIdOrder.invalid",
    rule: "navigation.linkIdOrder",
    expect: "invalid",
    target: "siteContent",
    description: "Swapping two navigation link ids is rejected at both positions.",
    patch: [
      { op: "replace", path: "/navigation/links/0/id", value: "parcours" },
      { op: "replace", path: "/navigation/links/1/id", value: "prestations" },
    ],
    expectedIssuePaths: ["/navigation/links/0/id", "/navigation/links/1/id"],
  },
  {
    id: "reassurance.itemIdOrder.invalid",
    rule: "reassurance.itemIdOrder",
    expect: "invalid",
    target: "siteContent",
    description: "Reordering reassurance items is rejected.",
    patch: [
      { op: "replace", path: "/reassurance/items/0/id", value: "hygiene-precision" },
      { op: "replace", path: "/reassurance/items/2/id", value: "natural-result" },
    ],
    expectedIssuePaths: ["/reassurance/items/0/id", "/reassurance/items/2/id"],
  },
  {
    id: "services.itemIdOrder.invalid",
    rule: "services.itemIdOrder",
    expect: "invalid",
    target: "siteContent",
    description:
      "Renaming a service id is rejected at that position. The visualKind and visual.id checks are keyed on the expected id, so they stay satisfied and only one issue is reported.",
    patch: [{ op: "replace", path: "/services/items/0/id", value: "lips" }],
    expectedIssuePaths: ["/services/items/0/id"],
  },
  {
    id: "services.visualKindMatchesId.invalid",
    rule: "services.visualKindMatchesId",
    expect: "invalid",
    target: "siteContent",
    description: "A service visualKind that disagrees with its id is rejected.",
    patch: [{ op: "replace", path: "/services/items/1/visualKind", value: "lips" }],
    expectedIssuePaths: ["/services/items/1/visualKind"],
  },
  {
    id: "services.visualIdMatchesId.invalid",
    rule: "services.visualIdMatchesId",
    expect: "invalid",
    target: "siteContent",
    description: "A service visual.id from another service is rejected.",
    patch: [
      {
        op: "replace",
        path: "/services/items/1/visual/id",
        value: "service-lips-placeholder",
      },
    ],
    expectedIssuePaths: ["/services/items/1/visual/id"],
  },
  {
    id: "process.stepIdOrder.invalid",
    rule: "process.stepIdOrder",
    expect: "invalid",
    target: "siteContent",
    description: "Reordering process step ids is rejected.",
    patch: [{ op: "replace", path: "/process/steps/1/id", value: "procedure" }],
    expectedIssuePaths: ["/process/steps/1/id"],
  },
  {
    id: "process.stepNumberOrder.invalid",
    rule: "process.stepNumberOrder",
    expect: "invalid",
    target: "siteContent",
    description: "A step number out of sequence is rejected.",
    patch: [{ op: "replace", path: "/process/steps/2/number", value: "04" }],
    expectedIssuePaths: ["/process/steps/2/number"],
  },
  {
    id: "gallery.itemIdOrder.invalid",
    rule: "gallery.itemIdOrder",
    expect: "invalid",
    target: "siteContent",
    description:
      "Renaming a gallery id is rejected at that position. The visualKind and visual.id checks are keyed on the expected id, so they stay satisfied and only one issue is reported.",
    patch: [{ op: "replace", path: "/gallery/items/1/id", value: "freckles" }],
    expectedIssuePaths: ["/gallery/items/1/id"],
  },
  {
    id: "gallery.visualKindMatchesId.invalid",
    rule: "gallery.visualKindMatchesId",
    expect: "invalid",
    target: "siteContent",
    description: "A gallery visualKind not bound to its item id is rejected.",
    patch: [{ op: "replace", path: "/gallery/items/0/visualKind", value: "healedBrows" }],
    expectedIssuePaths: ["/gallery/items/0/visualKind"],
  },
  {
    id: "gallery.visualIdMatchesId.invalid",
    rule: "gallery.visualIdMatchesId",
    expect: "invalid",
    target: "siteContent",
    description: "A gallery visual.id from another item is rejected.",
    patch: [
      {
        op: "replace",
        path: "/gallery/items/2/visual/id",
        value: "gallery-powder-lips-placeholder",
      },
    ],
    expectedIssuePaths: ["/gallery/items/2/visual/id"],
  },
  {
    id: "gallery.featuredOnlyFirstItem.firstMissing",
    rule: "gallery.featuredOnlyFirstItem",
    expect: "invalid",
    target: "siteContent",
    description: "Removing `featured` from the first gallery item is rejected.",
    patch: [{ op: "remove", path: "/gallery/items/0/featured" }],
    expectedIssuePaths: ["/gallery/items/0/featured"],
  },
  {
    id: "gallery.featuredOnlyFirstItem.extraFeatured",
    rule: "gallery.featuredOnlyFirstItem",
    expect: "invalid",
    target: "siteContent",
    description:
      "Marking a second gallery item as featured is rejected, even with value false.",
    patch: [{ op: "add", path: "/gallery/items/3/featured", value: false }],
    expectedIssuePaths: ["/gallery/items/3/featured"],
  },

  // -- fixed technical ids ----------------------------------------------
  {
    id: "hero.fixedLinkAndMediaIds.primaryCta",
    rule: "hero.fixedLinkAndMediaIds",
    expect: "invalid",
    target: "siteContent",
    description: "Renaming hero.primaryCta.id is rejected.",
    patch: [{ op: "replace", path: "/hero/primaryCta/id", value: "renamed" }],
    expectedIssuePaths: ["/hero/primaryCta/id"],
  },
  {
    id: "hero.fixedLinkAndMediaIds.visual",
    rule: "hero.fixedLinkAndMediaIds",
    expect: "invalid",
    target: "siteContent",
    description: "Renaming hero.visual.id is rejected.",
    patch: [{ op: "replace", path: "/hero/visual/id", value: "other-placeholder" }],
    expectedIssuePaths: ["/hero/visual/id"],
  },
  {
    id: "about.portraitFixedId.invalid",
    rule: "about.portraitFixedId",
    expect: "invalid",
    target: "siteContent",
    description: "Renaming about.portrait.id is rejected.",
    patch: [{ op: "replace", path: "/about/portrait/id", value: "portrait" }],
    expectedIssuePaths: ["/about/portrait/id"],
  },
  {
    id: "gallery.instagramCtaFixedId.invalid",
    rule: "gallery.instagramCtaFixedId",
    expect: "invalid",
    target: "siteContent",
    description: "Renaming gallery.instagramCta.id is rejected.",
    patch: [{ op: "replace", path: "/gallery/instagramCta/id", value: "renamed" }],
    expectedIssuePaths: ["/gallery/instagramCta/id"],
  },
  {
    id: "contact.fixedLinkIds.email",
    rule: "contact.fixedLinkIds",
    expect: "invalid",
    target: "siteContent",
    description: "Renaming contact.emailCta.id is rejected.",
    patch: [{ op: "replace", path: "/contact/emailCta/id", value: "mail" }],
    expectedIssuePaths: ["/contact/emailCta/id"],
  },
  {
    id: "footer.linkIdOrder.invalid",
    rule: "footer.linkIdOrder",
    expect: "invalid",
    target: "siteContent",
    description: "Renaming a footer link id is rejected.",
    patch: [{ op: "replace", path: "/footer/links/1/id", value: "email" }],
    expectedIssuePaths: ["/footer/links/1/id"],
  },

  // -- URL and media semantics ------------------------------------------
  {
    id: "links.mailtoHref.missingScheme",
    rule: "links.mailtoHref",
    expect: "invalid",
    target: "siteContent",
    description: "A bare address without the mailto scheme is rejected.",
    patch: [
      { op: "replace", path: "/contact/emailCta/href", value: "contact@esztergyori.com" },
    ],
    expectedIssuePaths: ["/contact/emailCta/href"],
  },
  {
    id: "links.mailtoHref.invalidAddress",
    rule: "links.mailtoHref",
    expect: "invalid",
    target: "siteContent",
    description: "A mailto link wrapping an unparseable address is rejected.",
    patch: [{ op: "replace", path: "/contact/emailCta/href", value: "mailto:not-an-email" }],
    expectedIssuePaths: ["/contact/emailCta/href"],
  },
  {
    id: "links.mailtoHref.valid",
    rule: "links.mailtoHref",
    expect: "valid",
    target: "siteContent",
    description: "A well-formed mailto link is accepted.",
    patch: [
      { op: "replace", path: "/contact/emailCta/href", value: "mailto:hello@example.com" },
    ],
  },
  {
    id: "links.instagramHttpsHost.httpRejected",
    rule: "links.instagramHttpsHost",
    expect: "invalid",
    target: "siteContent",
    description: "A plain-HTTP Instagram URL is rejected.",
    patch: [
      {
        op: "replace",
        path: "/contact/instagramCta/href",
        value: "http://www.instagram.com/eg_maquillagepermanent/",
      },
    ],
    expectedIssuePaths: ["/contact/instagramCta/href"],
  },
  {
    id: "links.instagramHttpsHost.foreignHostRejected",
    rule: "links.instagramHttpsHost",
    expect: "invalid",
    target: "siteContent",
    description: "An HTTPS URL on a look-alike host is rejected.",
    patch: [
      {
        op: "replace",
        path: "/contact/instagramCta/href",
        value: "https://instagram.com.evil.example/eg",
      },
    ],
    expectedIssuePaths: ["/contact/instagramCta/href"],
  },
  {
    id: "links.instagramHttpsHost.subdomainValid",
    rule: "links.instagramHttpsHost",
    expect: "valid",
    target: "siteContent",
    description: "An instagram.com subdomain over HTTPS is accepted.",
    patch: [
      {
        op: "replace",
        path: "/contact/instagramCta/href",
        value: "https://www.instagram.com/another_account/",
      },
    ],
  },
  {
    id: "media.sourceProtocol.javascriptRejected",
    rule: "media.sourceProtocol",
    expect: "invalid",
    target: "siteContent",
    description: "A javascript: media source is rejected.",
    patch: [
      { op: "replace", path: "/hero/visual/src", value: "javascript:alert(1)" },
    ],
    expectedIssuePaths: ["/hero/visual/src"],
  },
  {
    id: "media.sourceProtocol.dataRejected",
    rule: "media.sourceProtocol",
    expect: "invalid",
    target: "siteContent",
    description: "A data: media source is rejected.",
    patch: [
      {
        op: "replace",
        path: "/hero/visual/src",
        value: "data:image/png;base64,iVBORw0KGgo=",
      },
    ],
    expectedIssuePaths: ["/hero/visual/src"],
  },
  {
    id: "media.sourceProtocol.publicPathValid",
    rule: "media.sourceProtocol",
    expect: "valid",
    target: "siteContent",
    description: "A rooted public path is accepted.",
    patch: [{ op: "replace", path: "/hero/visual/src", value: "/media/hero.webp" }],
  },
  {
    id: "media.sourceProtocol.protocolRelativeRejected",
    rule: "media.sourceProtocol",
    expect: "invalid",
    target: "siteContent",
    description: "A protocol-relative //host path is rejected.",
    patch: [{ op: "replace", path: "/hero/visual/src", value: "//evil.example/x.png" }],
    expectedIssuePaths: ["/hero/visual/src"],
  },
  {
    id: "media.sourceProtocol.httpsAccepted",
    rule: "media.sourceProtocol",
    expect: "valid",
    target: "siteContent",
    description:
      "An HTTPS external media source is accepted, because the CMS accepts arbitrary HTTPS origins and the production CSP allows the `https:` scheme.",
    patch: [{ op: "replace", path: "/hero/visual/src", value: "https://images.example.com/hero.webp" }],
  },
  {
    id: "media.sourceProtocol.httpRejected",
    rule: "media.sourceProtocol",
    expect: "invalid",
    target: "siteContent",
    description:
      "An HTTP external media source is rejected everywhere: it would be browser-blocked by the production `img-src 'self' data: https:` policy and is an active downgrade vector.",
    patch: [{ op: "replace", path: "/hero/visual/src", value: "http://images.example.com/hero.webp" }],
    expectedIssuePaths: ["/hero/visual/src"],
  },
];
