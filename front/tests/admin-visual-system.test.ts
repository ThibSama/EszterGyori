import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The admin visual system, and the isolation it depends on (ESZ-158).
 *
 * The back-office has its own warm palette — greige canvas, cream surfaces,
 * taupe recesses, brown-black text, one sage accent — and the public site does
 * not. Those two facts are only compatible if the admin system is scoped, so
 * that is what this file pins: not that a colour is a particular hex, but that
 * every admin rule is unreachable from a public page, that the public tokens are
 * untouched, and that the palette clears the contrast it claims.
 */

const appRoot = join(process.cwd(), "app");
const adminComponentsRoot = join(appRoot, "components", "admin");

const globalsCss = readFileSync(join(appRoot, "globals.css"), "utf8");

const ADMIN_MARKER = "The admin visual system (ESZ-158)";
// The marker sits inside the block comment that opens the admin half, so the
// split is made at that comment's own start. Splitting on the marker itself
// would leave admin prose in the public half and open the admin half in the
// middle of a comment — which is enough to fool every assertion below.
const adminStart = globalsCss.lastIndexOf("/*", globalsCss.indexOf(ADMIN_MARKER));
const publicCss = globalsCss.slice(0, adminStart);
const adminCss = globalsCss.slice(adminStart);
/** The admin half with its commentary removed: rules and nothing else. */
const adminRules = adminCss.replace(/\/\*[\s\S]*?\*\//g, "");

const source = (name: string) =>
  readFileSync(join(adminComponentsRoot, name), "utf8");

const shellSource = source("admin-shell.tsx");
const providerSource = source("admin-session-provider.tsx");

/**
 * Strips comments and declaration bodies, leaving one selector per entry.
 *
 * The split is on top-level commas only: `:where(a, button, …)` is one selector,
 * and cutting it at its inner commas would report fragments that start with a
 * bare element name and read as unscoped when they are not.
 */
function selectorsOf(css: string): string[] {
  const selectors: string[] = [];
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const brace = block.indexOf("{");
    if (brace === -1) continue;

    let depth = 0;
    let current = "";
    const push = () => {
      const trimmed = current.trim();
      if (trimmed !== "" && !trimmed.startsWith("@")) selectors.push(trimmed);
      current = "";
    };
    for (const character of block.slice(0, brace)) {
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        push();
        continue;
      }
      current += character;
    }
    push();
  }
  return selectors;
}

// ----- The scope -----

test("every admin style rule is scoped to .admin-theme", () => {
  const unscoped = selectorsOf(adminCss).filter(
    (selector) => !selector.startsWith(".admin-theme"),
  );

  assert.deepEqual(
    unscoped,
    [],
    `admin rules must not be reachable from a public page: ${unscoped.join(", ")}`,
  );
});

test("the admin scope is applied by the shell and by the screens that replace it", () => {
  assert.match(
    shellSource,
    /className="admin-theme admin-canvas min-h-screen/,
    "the shell root carries the admin scope",
  );

  // The gate screens render *instead of* the shell, so they cannot inherit it.
  assert.match(providerSource, /className="admin-theme admin-canvas min-h-screen/);
  assert.match(providerSource, /className="admin-theme admin-canvas fixed inset-0/);
});

test("nothing outside app/components/admin declares the admin scope", () => {
  const offenders: string[] = [];

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "admin") continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (readFileSync(path, "utf8").includes("admin-theme")) {
        offenders.push(path);
      }
    }
  };

  walk(join(appRoot, "components"));
  walk(join(appRoot, "content"));

  assert.deepEqual(offenders, []);
});

test("the live preview is a separate document, so it cannot inherit the scope", () => {
  const viewport = source("admin-preview-viewport.tsx");

  // The preview frame sits inside the admin scope, but an <iframe> has its own
  // document: the page it loads renders the public theme, not admin chrome.
  assert.match(viewport, /<iframe/);
  assert.match(viewport, /src="\/admin\/preview"/);

  const previewPage = readFileSync(
    join(appRoot, "admin", "preview", "admin-preview-client.tsx"),
    "utf8",
  );
  assert.doesNotMatch(previewPage, /admin-theme/);
  assert.match(previewPage, /site-preview/);
});

// ----- Public isolation -----

test("the public theme tokens and the injected site colours are untouched", () => {
  // The public palette, exactly as the public build resolves it.
  for (const token of [
    "--color-warm-50: #F5F4F1",
    "--color-warm-900: #1D1C1A",
    "--color-sage-500: #63726C",
    "--color-porcelain: #FAFAF8",
  ]) {
    assert.ok(publicCss.includes(token), `${token} must stay unchanged`);
  }

  // The injected properties PHP writes, and the blending done over them.
  assert.match(publicCss, /\.site-preview \{[\s\S]*--site-section-hero: color-mix\(/);
  assert.match(publicCss, /background: var\(--site-background\)/);

  // No admin token leaks into the public half of the stylesheet, and no public
  // token is redefined in the admin half.
  assert.doesNotMatch(publicCss, /--admin-/);
  assert.doesNotMatch(adminRules, /--site-[a-z-]+:/);
  assert.doesNotMatch(adminRules, /@theme/);
});

test("the admin scope never targets a public rendering class", () => {
  for (const selector of selectorsOf(adminCss)) {
    assert.doesNotMatch(
      selector,
      /site-preview|site-section-|site-navigation-glass/,
      `${selector} would reach public rendering`,
    );
  }
});

// ----- The system itself -----

const TOKENS = Object.fromEntries(
  [...adminCss.matchAll(/(--admin-[a-z-]+):\s*(#[0-9a-f]{6})/g)].map(
    (match) => [match[1], match[2]] as const,
  ),
) as Record<string, string>;

test("the admin scope declares the full token set", () => {
  for (const token of [
    "--admin-canvas",
    "--admin-surface",
    "--admin-surface-muted",
    "--admin-surface-sunken",
    "--admin-border",
    "--admin-border-strong",
    "--admin-text",
    "--admin-text-muted",
    "--admin-text-subtle",
    "--admin-accent",
    "--admin-accent-strong",
    "--admin-focus",
    "--admin-ok-text",
    "--admin-warn-text",
    "--admin-danger-text",
  ]) {
    assert.ok(token in TOKENS, `${token} must be declared on .admin-theme`);
  }
});

test("no admin surface is pure white", () => {
  for (const [token, value] of Object.entries(TOKENS)) {
    if (!token.includes("surface") && !token.includes("canvas")) continue;
    assert.notEqual(
      value.toLowerCase(),
      "#ffffff",
      `${token} must carry a warm cast rather than pure white`,
    );
  }
});

test("the restyled admin surfaces carry no white fill and no drop shadow", () => {
  for (const name of [
    "admin-shell.tsx",
    "admin-overview.tsx",
    "admin-operations-summary.tsx",
    "content-editor.tsx",
    "content-workspace.tsx",
    "content-section-navigation.tsx",
    "editor-cards.tsx",
    "editor-fields.tsx",
  ]) {
    const contents = source(name);
    assert.doesNotMatch(contents, /\bbg-white\b/, `${name} still fills with white`);
    assert.doesNotMatch(
      contents,
      /shadow-\[/,
      `${name} still stacks a custom drop shadow`,
    );
  }
});

// ----- Accessibility properties the palette has to keep -----

function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928
      ? srgb / 12.92
      : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (high + 0.05) / (low + 0.05);
}

test("every admin text token clears 4.5:1 on the surface it is used on", () => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["--admin-text", "--admin-surface"],
    ["--admin-text", "--admin-canvas"],
    ["--admin-text", "--admin-surface-sunken"],
    ["--admin-text", "--admin-surface-muted"],
    ["--admin-text-muted", "--admin-surface"],
    ["--admin-text-muted", "--admin-canvas"],
    ["--admin-text-muted", "--admin-surface-sunken"],
    ["--admin-text-subtle", "--admin-surface"],
    ["--admin-text-subtle", "--admin-canvas"],
    ["--admin-text-subtle", "--admin-surface-sunken"],
    ["--admin-text-subtle", "--admin-surface-quiet"],
    ["--admin-text-muted", "--admin-surface-muted"],
    ["--admin-accent", "--admin-surface"],
    ["--admin-accent", "--admin-canvas"],
    ["--admin-accent-contrast", "--admin-accent"],
    ["--admin-surface", "--admin-text"],
    ["--admin-ok-text", "--admin-ok-surface"],
    ["--admin-warn-text", "--admin-warn-surface"],
    ["--admin-danger-text", "--admin-danger-surface"],
  ];

  for (const [foreground, background] of pairs) {
    const ratio = contrast(TOKENS[foreground], TOKENS[background]);
    assert.ok(
      ratio >= 4.5,
      `${foreground} on ${background} is ${ratio.toFixed(2)}:1, below 4.5:1`,
    );
  }
});

test("the accent carries small text on the canvas, so it clears 4.5:1 there", () => {
  // `.admin-text-accent` is the eyebrow above the overview greeting and above
  // the CMS section heading. Both sit directly on the canvas, not on a card, so
  // the pairing that actually ships is accent-on-canvas — the darker
  // accent-on-surface reading is not the one a reader is held to.
  for (const [file, className] of [
    ["admin-overview.tsx", "admin-text-accent"],
    ["content-editor.tsx", "admin-text-accent"],
  ] as const) {
    assert.ok(
      source(file).includes(className),
      `${file} is expected to render the accent eyebrow`,
    );
  }
  assert.match(adminCss, /\.admin-theme \.admin-text-accent \{ color: var\(--admin-accent\); \}/);

  const ratio = contrast(TOKENS["--admin-accent"], TOKENS["--admin-canvas"]);
  assert.ok(
    ratio >= 4.5,
    `--admin-accent on --admin-canvas is ${ratio.toFixed(2)}:1, below 4.5:1`,
  );
});

test("the focus outline stays visible and wins over the public rule", () => {
  // The public rule near the top of globals.css carries !important and resolves
  // against --site-primary, which the admin does not declare. The admin rule has
  // to match that weight or focus would fall back to the public sage.
  assert.match(
    adminCss,
    /\.admin-theme :where\(a, button, input, textarea, select, summary\):focus-visible[\s\S]*?outline: 3px solid var\(--admin-focus\) !important/,
  );
  assert.ok(
    contrast(TOKENS["--admin-focus"], TOKENS["--admin-surface"]) >= 3,
    "the focus outline must clear 3:1 against the surface it is drawn on",
  );
});

test("selection is never carried by colour alone", () => {
  // Shell rail, CMS rail: a bar element that exists only when active, a weight
  // change, and aria-current — three cues, none of them a hue.
  for (const contents of [shellSource, source("content-section-navigation.tsx")]) {
    assert.match(contents, /data-active-marker/);
    assert.match(contents, /active \? "admin-active-marker" : "bg-transparent"/);
    assert.match(contents, /active \? "font-semibold" : "font-normal"/);
    assert.match(contents, /aria-current=/);
  }

  // Segmented controls: the selected option is bolder, and says so in ARIA.
  assert.match(adminCss, /\.admin-segmented-option\[aria-pressed="true"\]/);
  assert.match(adminCss, /\.admin-segmented-option\[aria-selected="true"\]/);
  assert.match(
    adminCss,
    /\[aria-selected="true"\] \{[^}]*font-weight: 600/,
    "the selected segment must change weight, not only fill",
  );
});

test("a disabled control stays readable rather than being faded out", () => {
  assert.match(
    adminCss,
    /admin-btn-danger:disabled \{[\s\S]*?opacity: 1;/,
    "disabled admin buttons must state themselves with tone, not opacity",
  );
  assert.doesNotMatch(source("content-editor.tsx"), /disabled:opacity-60/);
  assert.ok(
    contrast(TOKENS["--admin-text-muted"], TOKENS["--admin-surface-muted"]) >= 4.5,
    "a disabled label must stay legible on the disabled surface",
  );
});

test("reduced motion is honoured across the whole admin scope", () => {
  const block = adminCss.slice(
    adminCss.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(block, /\.admin-theme \*/);
  assert.match(block, /transition-duration: 0\.01ms !important/);
  assert.match(block, /animation-duration: 0\.01ms !important/);

  // The one scripted scroll in the admin already asks before choosing `smooth`.
  assert.match(
    source("content-editor.tsx"),
    /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\s*\n?\s*\?\s*"auto"/,
  );
});
