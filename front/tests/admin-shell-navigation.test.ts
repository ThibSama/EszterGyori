import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ADMIN_NAV_ITEMS,
  ADMIN_SECONDARY_ITEMS,
  activeAdminNavKey,
  isAdminNavItemActive,
} from "../app/lib/admin-navigation";

const appRoot = join(process.cwd(), "app");

const shellSource = readFileSync(
  join(appRoot, "components", "admin", "admin-shell.tsx"),
  "utf8",
);
const layoutSource = readFileSync(
  join(appRoot, "admin", "(protected)", "layout.tsx"),
  "utf8",
);
const providerSource = readFileSync(
  join(appRoot, "components", "admin", "admin-session-provider.tsx"),
  "utf8",
);

/** The routes the protected export actually emits (ESZ-154 AC5, ESZ-155). */
const LIVE_ADMIN_ROUTES = [
  { href: "/admin", page: join(appRoot, "admin", "(protected)", "page.tsx") },
  {
    href: "/admin/content",
    page: join(appRoot, "admin", "(protected)", "content", "page.tsx"),
  },
  {
    href: "/admin/bookings",
    page: join(appRoot, "admin", "(protected)", "bookings", "page.tsx"),
  },
  {
    href: "/admin/availability",
    page: join(appRoot, "admin", "(protected)", "availability", "page.tsx"),
  },
] as const;

test("the first level is exactly the four canonical business destinations, in order", () => {
  assert.deepEqual(
    ADMIN_NAV_ITEMS.map((item) => item.label),
    ["Vue d’ensemble", "Contenu du site", "Calendrier", "Prestations"],
  );
});

test("Rendez-vous and Disponibilités are no longer first-level destinations", () => {
  // They converge under Calendrier. The routes stay reachable; the labels must
  // not reappear anywhere in the rendered chrome, in the model or in the markup.
  for (const removed of ["Rendez-vous", "Disponibilités"]) {
    assert.ok(
      !ADMIN_NAV_ITEMS.some((item) => item.label === removed),
      `${removed} must not be a first-level entry`,
    );
    assert.ok(
      !ADMIN_SECONDARY_ITEMS.some((item) => item.label === removed),
      `${removed} must not reappear in the secondary band`,
    );
    assert.ok(
      !shellSource.includes(removed),
      `${removed} must not be hard-coded into the shell`,
    );
  }
});

test("every clickable entry points at a route that exists, and nothing else is clickable", () => {
  const entries = [...ADMIN_NAV_ITEMS, ...ADMIN_SECONDARY_ITEMS];
  const navigable = new Map(
    entries
      .filter((item) => item.status === "available")
      .map((item) => [item.label, item.href]),
  );

  assert.deepEqual(
    Object.fromEntries(navigable),
    {
      // ESZ-155 turned `/admin` into the overview and moved the CMS to its own
      // route. Both are live; `Prestations` still has no page to open.
      "Vue d’ensemble": "/admin",
      "Contenu du site": "/admin/content",
      Calendrier: "/admin/bookings",
    },
    "only destinations backed by a usable route may be clickable",
  );

  for (const href of navigable.values()) {
    const route = LIVE_ADMIN_ROUTES.find((candidate) => candidate.href === href);
    assert.ok(route, `${href} must be one of the protected admin routes`);
    assert.ok(
      existsSync(route.page),
      `${href} must be backed by a page on disk, not a dead link`,
    );
  }
});

test("Calendrier is a real entry point, not a claim that Package 10.2 shipped", () => {
  const calendar = ADMIN_NAV_ITEMS.find((item) => item.key === "calendar");
  assert.ok(calendar && calendar.status === "available");
  assert.equal(calendar.href, "/admin/bookings");

  // The page it opens already calls itself the calendar; the entry borrows that
  // page rather than inventing a consolidated one.
  const bookings = readFileSync(
    join(appRoot, "components", "admin", "admin-booking-calendar.tsx"),
    "utf8",
  );
  assert.ok(
    bookings.includes("Calendrier"),
    "the borrowed route must actually present itself as the calendar",
  );

  // Package 10.2 owns the consolidation. Until it lands, the availability editor
  // stays its own page rather than being folded in here.
  const bookingsPage = readFileSync(
    join(appRoot, "admin", "(protected)", "bookings", "page.tsx"),
    "utf8",
  );
  assert.doesNotMatch(
    bookingsPage,
    /AdminAvailabilityEditor/,
    "the unified calendar belongs to Package 10.2, not to this shell pass",
  );
});

test("pending destinations are declared but announce themselves as not yet available", () => {
  const pending = [...ADMIN_NAV_ITEMS, ...ADMIN_SECONDARY_ITEMS].filter(
    (item) => item.status === "pending",
  );

  assert.deepEqual(pending.map((item) => item.label), [
    "Prestations",
    "Besoin d’aide",
    "Paramètres",
  ]);
  for (const item of pending) {
    assert.equal(item.pendingLabel, "Bientôt");
    assert.ok(
      !("href" in item),
      `${item.label} must not carry a destination while it has no route`,
    );
  }
});

test("no placeholder page was created for a pending destination", () => {
  for (const segment of [
    "overview",
    "services",
    "prestations",
    "settings",
    "parametres",
    "aide",
    "help",
    "calendrier",
    "calendar",
  ]) {
    assert.ok(
      !existsSync(join(appRoot, "admin", "(protected)", segment)),
      `${segment} must not exist: later checkpoints and Package 10.2 own those routes`,
    );
  }
});

test("the lower band is Help, then the account and its sign-out, then Settings", () => {
  assert.deepEqual(
    ADMIN_SECONDARY_ITEMS.map((item) => item.label),
    ["Besoin d’aide", "Paramètres"],
  );

  const band = shellSource.slice(
    shellSource.indexOf('data-testid="admin-shell-secondary"'),
  );
  const help = band.indexOf("ADMIN_SECONDARY_ITEMS[0]");
  const badge = band.indexOf("<AdminSessionBadge />");
  const settings = band.indexOf("ADMIN_SECONDARY_ITEMS[1]");

  assert.ok(help > 0 && badge > help, "the account must follow “Besoin d’aide”");
  assert.ok(settings > badge, "“Paramètres” must sit at the bottom of the band");
});

test("the secondary band sits outside the navigation landmark", () => {
  const navStart = shellSource.indexOf("<nav");
  const navEnd = shellSource.indexOf("</nav>");
  const nav = shellSource.slice(navStart, navEnd);

  assert.ok(!nav.includes("ADMIN_SECONDARY_ITEMS"));
  assert.ok(!nav.includes("<AdminSessionBadge />"));
  assert.ok(
    shellSource.indexOf('data-testid="admin-shell-secondary"') > navEnd,
    "the secondary band must be rendered after the navigation landmark closes",
  );
});

test("the return to the public site stays reachable, above the settings slot", () => {
  assert.match(shellSource, /href="\/"/);
  assert.match(shellSource, /← Retour au site/);
  assert.ok(
    shellSource.indexOf("← Retour au site") <
      shellSource.indexOf("ADMIN_SECONDARY_ITEMS[1]"),
    "“Paramètres” must remain the last thing in the chrome",
  );
});

test("the active entry is the one the operator is on, and there is exactly one", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["/admin", "overview"],
    ["/admin/", "overview"],
    ["/admin/content", "content"],
    ["/admin/content/", "content"],
    ["/admin/bookings", "calendar"],
    ["/admin/bookings/", "calendar"],
    ["/admin/bookings/2026-09", "calendar"],
    // Still reachable directly, and now represented by Calendrier rather than by
    // a first-level entry of its own.
    ["/admin/availability", "calendar"],
    ["/admin/availability/weekly", "calendar"],
    ["/admin/login", null],
    ["/admin/preview", null],
    ["/", null],
  ];

  for (const [pathname, expected] of cases) {
    assert.equal(
      activeAdminNavKey(pathname),
      expected,
      `${pathname} should resolve to ${expected ?? "no entry"}`,
    );

    const matching = ADMIN_NAV_ITEMS.filter((item) =>
      isAdminNavItemActive(item, pathname),
    );
    assert.ok(
      matching.length <= 1,
      `${pathname} matched more than one entry: ${matching
        .map((item) => item.key)
        .join(", ")}`,
    );
  }

  assert.equal(activeAdminNavKey(null), null);
});

test("“Vue d’ensemble” does not stay lit on the routes below it", () => {
  // `/admin` is the prefix of every other admin route, so the overview is the
  // one entry that must match exactly. Without that, it would light up on the
  // CMS, the calendar and the availability editor alike.
  const overview = ADMIN_NAV_ITEMS.find((item) => item.key === "overview");
  assert.ok(overview && overview.status === "available" && overview.exact);

  for (const pathname of [
    "/admin/content",
    "/admin/bookings",
    "/admin/availability",
  ]) {
    assert.equal(isAdminNavItemActive(overview, pathname), false);
  }
});

test("no pending entry can ever resolve as active", () => {
  for (const item of [...ADMIN_NAV_ITEMS, ...ADMIN_SECONDARY_ITEMS]) {
    if (item.status !== "pending") continue;
    for (const pathname of [
      "/admin",
      "/admin/content",
      "/admin/bookings",
      "/admin/availability",
    ]) {
      assert.equal(isAdminNavItemActive(item, pathname), false);
    }
  }
});

test("the shell marks the current destination beyond colour alone", () => {
  assert.match(
    shellSource,
    /aria-current=\{active \? "page" : undefined\}/,
    "the active link must expose aria-current=page",
  );
  assert.match(
    shellSource,
    /active \? "font-semibold" : "font-normal"/,
    "the active label must change weight, not only colour",
  );
  assert.match(
    shellSource,
    /data-active-marker/,
    "the active entry must carry a visible non-colour marker element",
  );
  assert.match(
    shellSource,
    /active \? "admin-active-marker" : "bg-transparent"/,
    "the marker must be present only while active",
  );
});

test("pending entries take no tab stop and offer no navigation", () => {
  const entry = shellSource.slice(shellSource.indexOf("function AdminNavEntry"));
  const branch = entry.slice(0, entry.indexOf("return (\n    <Link"));

  assert.match(branch, /<span\b/, "a pending entry must not render an anchor");
  assert.match(branch, /aria-disabled="true"/);
  assert.match(branch, /data-nav-status="pending"/);
  assert.doesNotMatch(branch, /href=/);
  assert.doesNotMatch(branch, /tabIndex/);
  assert.doesNotMatch(branch, /onClick/);
});

test("the navigation is one semantic landmark rendered once", () => {
  assert.equal((shellSource.match(/<nav\b/g) ?? []).length, 1);
  assert.match(shellSource, /aria-label="Navigation de l’administration"/);
  assert.equal((shellSource.match(/<\/ul>/g) ?? []).length, 1);
  assert.equal((shellSource.match(/ADMIN_NAV_ITEMS\.map/g) ?? []).length, 1);
});

test("the shell is a persistent sidebar on desktop and a compact rail when narrow", () => {
  assert.match(shellSource, /lg:sticky lg:top-0/);
  assert.match(shellSource, /lg:h-screen lg:w-64/);
  assert.match(
    shellSource,
    /flex gap-1 overflow-x-auto py-2 lg:flex-col/,
    "narrow layouts must keep the entries on one scrollable row",
  );
  assert.match(
    shellSource,
    /min-w-0 flex-1/,
    "the work area must keep the remaining width",
  );
  assert.match(
    shellSource,
    /flex items-center gap-2 overflow-x-auto border-t/,
    "the secondary band must scroll rather than overflow the narrow chrome",
  );
  assert.match(
    shellSource,
    /lg:mt-auto/,
    "the secondary band must fall to the bottom of the desktop sidebar",
  );
});

test("the shell carries the identity, the role and the sign-out control", () => {
  assert.match(shellSource, />\s*Eszter\s*</);
  assert.match(shellSource, />\s*Administration\s*</);
  assert.match(shellSource, /<AdminSessionBadge \/>/);

  assert.match(providerSource, /Se déconnecter/);
  assert.match(providerSource, /data-testid="admin-account-email"/);
});

test("the signed-in account identity survives the narrow layout", () => {
  const badge = providerSource.slice(providerSource.indexOf("export function AdminSessionBadge"));
  const identity = badge.slice(
    badge.lastIndexOf("<span", badge.indexOf('data-testid="admin-account-email"')),
    badge.indexOf('data-testid="admin-account-email"'),
  );

  // The blocking ESZ-154 review finding: `hidden ... sm:block` removed the
  // account identity from the rendered UI below `sm`, so an operator on a 375 px
  // screen could sign out without being able to tell which account they were
  // signing out of. It must not come back — and it must not come back disguised
  // as screen-reader-only text either, which answers assistive technology alone.
  assert.doesNotMatch(identity, /["\s]hidden["\s]/);
  assert.doesNotMatch(identity, /sr-only/);
  assert.match(identity, /["\s]block["\s]/);
  assert.match(
    identity,
    /max-w-\[8rem\]/,
    "the identity must stay bounded so it cannot be pushed out of a 375 px viewport",
  );
});

test("the protected layout mounts the shell once, inside the unchanged session provider", () => {
  assert.match(
    layoutSource,
    /<AdminSessionProvider>\s*<AdminShell>\{children\}<\/AdminShell>\s*<\/AdminSessionProvider>/,
    "the session/logout flow must still wrap the whole protected area",
  );
  assert.equal((layoutSource.match(/<AdminShell>/g) ?? []).length, 1);
});

test("no protected page renders navigation of its own", () => {
  for (const { page } of LIVE_ADMIN_ROUTES) {
    const source = readFileSync(page, "utf8");
    assert.doesNotMatch(
      source,
      /<nav\b/,
      `${page} must rely on the shell rather than duplicating navigation`,
    );
  }
});
