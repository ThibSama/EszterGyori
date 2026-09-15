"use client";

import {
  ADMIN_CONTENT_AREAS,
  adminContentArea,
  adminContentSection,
  type AdminContentAreaKey,
  type AdminContentSectionKey,
  type AdminContentSelection,
} from "../../lib/admin-content-navigation";

/**
 * The CMS's own navigation: where in the site, then which part of it (ESZ-156).
 *
 * One DOM at every width, for the reason the admin shell gives: a second copy
 * hidden by a media query would put two `aria-current` entries in the
 * accessibility tree and double the tab stops. Here it is a column beside the
 * editor from `lg` up and, below it, two horizontally scrollable rows above the
 * workspace — the same list, the same state, laid out differently.
 *
 * The selected entry is marked three ways so the fact survives greyscale and
 * colour-vision deficiency: the bar exists only when active, the label goes
 * semibold, and `aria-current` carries it to assistive technology.
 *
 * Every control here is a button that calls back. Nothing in this component
 * touches the content document: choosing a section is navigation, and the only
 * thing it changes is which editor the workspace renders.
 */
export function ContentSectionNavigation({
  selection,
  onSelectArea,
  onSelectSection,
}: {
  selection: AdminContentSelection;
  onSelectArea: (area: AdminContentAreaKey) => void;
  onSelectSection: (section: AdminContentSectionKey) => void;
}) {
  const area = adminContentArea(selection.area);

  return (
    <nav
      aria-label="Sections du contenu"
      data-testid="cms-section-navigation"
      className="admin-panel min-w-0 rounded-2xl p-3 lg:sticky lg:top-6">
      <p
        id="cms-area-label"
        className="admin-text-subtle px-1 pb-2 text-xs font-medium uppercase tracking-[0.18em]">
        Zone du site
      </p>
      <ul
        aria-labelledby="cms-area-label"
        className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-x-visible">
        {ADMIN_CONTENT_AREAS.map((candidate) => (
          <li key={candidate.key} className="lg:w-full">
            <NavEntry
              label={candidate.label}
              active={candidate.key === selection.area}
              dataKey={candidate.key}
              dataRole="area"
              onClick={() => onSelectArea(candidate.key)}
            />
          </li>
        ))}
      </ul>

      <p className="admin-border admin-text-muted border-t px-1 pb-2 pt-3 text-sm leading-relaxed">
        {area.description}
      </p>

      <p
        id="cms-section-label"
        className="admin-text-subtle px-1 pb-2 text-xs font-medium uppercase tracking-[0.18em]">
        Section
      </p>
      <ul
        aria-labelledby="cms-section-label"
        className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-x-visible">
        {area.sections.map((section) => (
          <li key={section} className="lg:w-full">
            <NavEntry
              label={adminContentSection(section).label}
              active={section === selection.section}
              dataKey={section}
              dataRole="section"
              onClick={() => onSelectSection(section)}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NavEntry({
  label,
  active,
  dataKey,
  dataRole,
  onClick,
}: {
  label: string;
  active: boolean;
  dataKey: string;
  dataRole: "area" | "section";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      data-cms-nav={dataRole}
      data-cms-key={dataKey}
      className={`admin-nav-entry flex w-full shrink-0 items-center gap-2 whitespace-nowrap rounded-xl py-2 pl-2 pr-3 text-left text-sm transition focus:outline-none focus:ring-2 focus:ring-sage-300 ${
        active ? "font-semibold" : "font-normal"
      }`}>
      {/* The active cue that is not colour, kept in the box when inactive so the
          labels stay on one baseline grid. */}
      <span
        aria-hidden="true"
        data-active-marker={active ? "true" : "false"}
        className={`h-4 w-[3px] shrink-0 rounded-full ${
          active ? "admin-active-marker" : "bg-transparent"
        }`}
      />
      <span className="min-w-0 lg:truncate">{label}</span>
    </button>
  );
}
