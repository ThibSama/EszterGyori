/**
 * The information architecture of the protected admin (ESZ-154).
 *
 * The shell renders these lists; it does not invent them. Keeping the model here,
 * as data rather than as markup, is what makes the facts below testable without
 * rendering anything:
 *
 * - the first level is exactly four business destinations, in one canonical
 *   order. `Rendez-vous` and `Disponibilités` are no longer first-level: they
 *   converge under `Calendrier`, which is where Package 10.2 will consolidate
 *   appointments, availability, working hours, breaks, temporary unavailability,
 *   closures and holidays into one surface.
 * - a destination is clickable *only* if a usable route already exists for it.
 *   Everything else is declared and inert: a link to a page that 404s is worse
 *   than an honest "bientôt", and inventing a placeholder page to make a label
 *   clickable would be worse still.
 * - the active entry is derived from the pathname by one function, so the
 *   sidebar cannot disagree with itself between two renders.
 *
 * Giving a pending entry an `href` is the single edit that turns it live — no
 * markup change, and the tests that assert "no dead link" follow along.
 */

/** A navigation entry, either navigable or declared-but-not-yet-built. */
export type AdminNavItem =
  | {
      readonly key: string;
      readonly label: string;
      /** The route this entry opens. Present exactly when the route exists. */
      readonly href: string;
      readonly status: "available";
      /**
       * `true` when only an exact pathname match counts as active. `/admin` is
       * the prefix of every other admin route, so prefix-matching it would light
       * up "Contenu du site" on every page below it.
       */
      readonly exact: boolean;
      /**
       * Extra routes this destination represents while the product is mid-flight.
       * A route that still works but has lost its own first-level entry has to
       * light *something* up, or the shell goes blank on a page the operator is
       * legitimately standing on.
       */
      readonly alsoMatches?: readonly string[];
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly status: "pending";
      /** Shown next to the label, and read out by assistive technology. */
      readonly pendingLabel: string;
    };

/** What a pending entry announces, in the shell and to a screen reader. */
export const ADMIN_NAV_PENDING_LABEL = "Bientôt";

/**
 * The four first-level business destinations, in canonical order.
 *
 * `Vue d’ensemble` is live (ESZ-155): `/admin` is the operational overview, and
 * it is matched exactly because `/admin` is the prefix of every other admin
 * route. The CMS moved off that route to `/admin/content` in the same pass, so
 * `Contenu du site` points there — the editor is unchanged, only its address is,
 * and ESZ-156 owns the CMS's own UX refactor.
 *
 * `Calendrier` points at `/admin/bookings` because that page already *is* the
 * calendar — it renders `<h1>Calendrier</h1>` over a month/day grid of
 * appointments. Pointing at it is an honest entry point, not a claim that
 * Package 10.2 has shipped: the consolidation of availability, closures and
 * holidays into that page is that package's work, and until then
 * `/admin/availability` keeps working as a direct route without a first-level
 * label of its own.
 *
 * `Prestations` is live (ESZ-149): `/admin/services` is the service catalog —
 * add, edit and archive a service with its name, description, duration and
 * image — and the entry got its `href` the moment that route became usable.
 */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  {
    key: "overview",
    label: "Vue d’ensemble",
    href: "/admin",
    status: "available",
    // `/admin` is the prefix of every other admin route, so only an exact match
    // may light the overview up.
    exact: true,
  },
  {
    key: "content",
    label: "Contenu du site",
    href: "/admin/content",
    status: "available",
    // Nothing lives below `/admin/content` yet. Prefix-matching it costs nothing
    // today and keeps the entry lit if ESZ-156 gives the CMS sub-routes.
    exact: false,
  },
  {
    key: "calendar",
    label: "Calendrier",
    href: "/admin/bookings",
    status: "available",
    exact: false,
    // Availability converged under Calendrier in the information architecture
    // before it converged in the product. The route is still reachable, so the
    // destination that now conceptually contains it is the one that marks it.
    alsoMatches: ["/admin/availability"],
  },
  {
    key: "services",
    label: "Prestations",
    href: "/admin/services",
    status: "available",
    // Nothing lives below `/admin/services` today; prefix-matching keeps the
    // entry lit if the catalog ever gains a detail route.
    exact: false,
  },
];

/**
 * The secondary controls in the lower shell, in canonical order.
 *
 * Both are inert, for the same reason: no support destination and no account or
 * application settings page exist in this repository. Rendering them as visible
 * pending entries states where the product is going; giving either an `href`
 * would require inventing a screen, and `Paramètres` in particular is reserved
 * for real account/application settings rather than a stub.
 *
 * The account identity and the sign-out control sit between these two in the
 * shell. They are not modelled here because they are not destinations — they are
 * the live session, rendered by `AdminSessionBadge`.
 */
export const ADMIN_SECONDARY_ITEMS: readonly AdminNavItem[] = [
  {
    key: "help",
    label: "Besoin d’aide",
    status: "pending",
    pendingLabel: ADMIN_NAV_PENDING_LABEL,
  },
  {
    key: "settings",
    label: "Paramètres",
    status: "pending",
    pendingLabel: ADMIN_NAV_PENDING_LABEL,
  },
];

/**
 * Drops a trailing slash so `/admin/bookings/` and `/admin/bookings` resolve to
 * the same entry. The export is configured `trailingSlash: false`, but a browser
 * or a proxy can still hand us either form, and the sidebar should not go blank
 * because of a slash.
 */
function normalisePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * The route prefix by which `item` claims `pathname`, or `null`. The prefix is
 * returned rather than a boolean so the caller can break a tie between two
 * matching entries by specificity.
 */
function matchedRoute(item: AdminNavItem, pathname: string | null): string | null {
  if (item.status !== "available" || pathname === null) return null;

  const current = normalisePath(pathname);
  for (const base of [item.href, ...(item.alsoMatches ?? [])]) {
    if (current === base) return base;
    if (!item.exact && current.startsWith(`${base}/`)) return base;
  }
  return null;
}

/** True when `pathname` is a destination this entry represents. */
export function isAdminNavItemActive(
  item: AdminNavItem,
  pathname: string | null,
): boolean {
  return matchedRoute(item, pathname) !== null;
}

/**
 * The single active entry for a pathname, or `null` on a route the shell does
 * not represent (`/admin/login`, `/admin/preview`).
 *
 * Resolving here rather than per-item guarantees exactly one `aria-current` in
 * the rendered navigation even if two entries were to match: the most specific
 * match — the longest matched route — wins, which is the one the operator is on.
 */
export function activeAdminNavKey(pathname: string | null): string | null {
  let best: { key: string; length: number } | null = null;

  for (const item of ADMIN_NAV_ITEMS) {
    const matched = matchedRoute(item, pathname);
    if (matched === null) continue;
    if (best === null || matched.length > best.length) {
      best = { key: item.key, length: matched.length };
    }
  }

  return best?.key ?? null;
}

/**
 * The first-level entry with this key.
 *
 * The overview's quick actions resolve their destinations through this rather
 * than repeating the routes, which is what stops the shell and the overview
 * disagreeing about whether a destination exists: a pending entry is pending in
 * both places, and giving it an `href` turns it live in both at once.
 */
export function adminNavItem(key: string): AdminNavItem {
  const item = ADMIN_NAV_ITEMS.find((candidate) => candidate.key === key);
  if (item === undefined) {
    throw new Error(`Unknown admin navigation key: ${key}`);
  }
  return item;
}
