"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ADMIN_NAV_ITEMS,
  ADMIN_SECONDARY_ITEMS,
  activeAdminNavKey,
  type AdminNavItem,
} from "../../lib/admin-navigation";
import { AdminSessionBadge } from "./admin-session-provider";

/**
 * The chrome every protected admin view sits inside (ESZ-154).
 *
 * One instance, rendered by the protected layout, so a page never carries its own
 * navigation and the first-level entries cannot drift apart between views.
 *
 * The shell has three bands, and the split is the information architecture made
 * visible: the identity and the way back to the public site at the top, the four
 * business destinations in the middle, and the secondary controls — help, the
 * signed-in account with its sign-out, and settings last — at the bottom.
 *
 * The responsive behaviour is deliberately one DOM, not two: the same header, the
 * same `<ul>` and the same secondary band become a sticky 16rem sidebar at `lg`
 * and, below it, a compact banner over two horizontally scrollable rows.
 * Rendering the navigation twice and hiding one copy would put two
 * `aria-current="page"` entries in the accessibility tree and double the tab
 * stops, and a drawer would cost the operator a click on every navigation — on a
 * narrow screen the rails take a row each and give the work area back the rest.
 *
 * Pages below still own their own `<main>` and their own vertical rhythm; the
 * shell only supplies the column they live in.
 *
 * ESZ-158 puts `admin-theme` on this root. Every admin-scoped rule in
 * `globals.css` hangs off that class, so the warm system reaches the shell and
 * everything rendered inside it — and reaches nothing else. The public pages,
 * the login screen and the preview document are all outside this element; the
 * preview in particular is an `<iframe>` with its own document, so it renders
 * the public theme even though its frame sits inside this tree.
 *
 * The only other element that carries `admin-theme` is the session provider's
 * gate screen, and for the same reason inverted: it renders *instead of* this
 * shell, so it cannot inherit the scope and has to declare it.
 */
export function AdminShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const activeKey = activeAdminNavKey(pathname);
  const railRef = useRef<HTMLUListElement>(null);

  // On a narrow screen the entries may not fit, and the one the operator is on
  // can start off-screen — an active state nobody can see is not one. Nudge the
  // rail's own `scrollLeft` rather than calling `scrollIntoView`, which would be
  // free to scroll the document out from under the workspace.
  //
  // It has to run on resize as well as on navigation: a window narrowed from the
  // sidebar layout turns a rail that fitted into one that does not, and nothing
  // else would put the active entry back in view.
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null || activeKey === null) return;

    const revealActiveEntry = () => {
      const entry = rail.querySelector<HTMLElement>(
        `[data-nav-key="${activeKey}"]`,
      );
      if (entry === null || rail.scrollWidth <= rail.clientWidth) return;

      const left = entry.offsetLeft;
      const right = left + entry.offsetWidth;
      if (left < rail.scrollLeft) {
        rail.scrollLeft = left;
      } else if (right > rail.scrollLeft + rail.clientWidth) {
        rail.scrollLeft = right - rail.clientWidth;
      }
    };

    revealActiveEntry();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealActiveEntry);
    observer.observe(rail);
    return () => {
      observer.disconnect();
    };
  }, [activeKey]);

  return (
    <div className="admin-theme admin-canvas min-h-screen lg:flex">
      <header className="admin-chrome admin-border z-40 border-b lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 lg:block lg:px-5 lg:py-6">
          <div>
            <p className="admin-text font-display text-base font-light leading-tight">
              Eszter
            </p>
            <p className="admin-text-subtle text-xs uppercase tracking-[0.18em]">
              Administration
            </p>
          </div>
          {/* The way out of the admin stays in the top band, next to the identity
              it belongs to. Putting it below “Paramètres” would take the bottom
              slot the canonical architecture reserves for settings. */}
          <Link
            href="/"
            className="admin-btn-secondary inline-flex shrink-0 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300 lg:mt-5 lg:w-full">
            ← Retour au site
          </Link>
        </div>

        <nav
          aria-label="Navigation de l’administration"
          className="admin-border border-t px-2 lg:flex-1 lg:border-t-0 lg:px-3">
          <ul
            ref={railRef}
            className="flex gap-1 overflow-x-auto py-2 lg:flex-col lg:overflow-x-visible">
            {ADMIN_NAV_ITEMS.map((item) => (
              <li key={item.key} className="lg:w-full">
                <AdminNavEntry item={item} active={item.key === activeKey} />
              </li>
            ))}
          </ul>
        </nav>

        {/* The secondary band, outside the navigation landmark on purpose: help,
            the live session and settings are not first-level destinations, and
            folding them into the navigation landmark would make the four entries
            impossible to state — in the accessibility tree or in a test. */}
        <div
          data-testid="admin-shell-secondary"
          className="admin-border flex items-center gap-2 overflow-x-auto border-t px-2 py-1.5 lg:mt-auto lg:flex-col lg:items-stretch lg:gap-3 lg:overflow-x-visible lg:px-3 lg:pb-6 lg:pt-4">
          <AdminNavEntry item={ADMIN_SECONDARY_ITEMS[0]} active={false} />
          <div className="min-w-0 shrink-0 lg:w-full">
            <AdminSessionBadge />
          </div>
          <AdminNavEntry
            item={ADMIN_SECONDARY_ITEMS[1]}
            active={ADMIN_SECONDARY_ITEMS[1].key === activeKey}
          />
        </div>
      </header>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const ENTRY_BASE =
  "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl py-2 pr-3 text-sm";

function AdminNavEntry({
  item,
  active,
}: {
  item: AdminNavItem;
  active: boolean;
}) {
  if (item.status === "pending") {
    // Declared in the information architecture, not yet a route. It is rendered
    // as inert text rather than a disabled link on purpose: there is nothing to
    // navigate to, so it takes no tab stop and offers no click that would 404.
    return (
      <span
        aria-disabled="true"
        data-nav-key={item.key}
        data-nav-status="pending"
        className={`${ENTRY_BASE} admin-nav-entry-inert cursor-default pl-2 lg:w-full`}>
        <ActiveMarker active={false} />
        <span>{item.label}</span>
        <span className="admin-chip rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide">
          {item.pendingLabel}
        </span>
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      data-nav-key={item.key}
      data-nav-status="available"
      className={`${ENTRY_BASE} admin-nav-entry pl-2 transition focus:outline-none focus:ring-2 focus:ring-sage-300 lg:w-full ${
        active ? "font-semibold" : "font-normal"
      }`}>
      <ActiveMarker active={active} />
      <span>{item.label}</span>
    </Link>
  );
}

/**
 * The active cue that is not colour.
 *
 * Contrast alone would fail anyone reading this in greyscale or with a colour
 * vision deficiency, so the current entry is marked three ways that survive it:
 * this bar exists only when active, the label goes semibold, and `aria-current`
 * carries the same fact to assistive technology. The inactive bar keeps its box
 * so labels stay on one baseline grid.
 */
function ActiveMarker({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-active-marker={active ? "true" : "false"}
      className={`h-4 w-[3px] shrink-0 rounded-full ${
        active ? "admin-active-marker" : "bg-transparent"
      }`}
    />
  );
}
