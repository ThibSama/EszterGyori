import { LEGAL_PAGE_LINKS } from "@eszter/contracts";
import type { FooterContent } from "../types/site-content";

/**
 * The footer: the editable copyright line and the content links (Instagram,
 * contact), then the two legal pages (ESZ-165). The legal destinations are
 * fixed constants of the contract, not `SiteContent` fields: their paths are
 * frozen (`/confidentialite` by the ESZ-161 booking notice), so they are
 * never editable URLs.
 *
 * Shared so the public site and the reservation shell reach the same legal
 * destinations from the same markup. `variant` only changes the surface: the
 * public site keeps the preview hooks and the warm gradient, the reservation
 * page stays calmer and task-focused with a plain rule above it.
 */
export function SiteFooter({
  content,
  variant = "public",
}: {
  content: FooterContent;
  variant?: "public" | "reservation";
}) {
  const isPublic = variant === "public";
  return (
    <footer
      data-preview-section={isPublic ? "site-section-footer" : undefined}
      className={
        isPublic
          ? "site-section-footer relative z-10 border-t border-warm-300/50 py-8 md:py-10 px-4 md:px-6 bg-gradient-to-b from-warm-100/60 to-warm-200/40"
          : "relative z-10 border-t border-warm-300/50 px-4 py-8 md:px-6 md:py-10"
      }>
      <div
        className={`${isPublic ? "max-w-6xl" : "max-w-5xl"} mx-auto flex flex-col sm:flex-row justify-between items-center gap-4`}>
        <p className="text-sm text-warm-600">
          &copy; {new Date().getFullYear()} {content.copyrightName}.{" "}
          {content.copyrightSuffix}
        </p>
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-warm-600">
          {content.links.map((link) => (
            <a
              key={link.id}
              href={link.href}
              target={link.href.startsWith("http") ? "_blank" : undefined}
              rel={
                link.href.startsWith("http") ? "noopener noreferrer" : undefined
              }
              className="hover:text-warm-800 transition-colors duration-300">
              {link.label}
            </a>
          ))}
          {LEGAL_PAGE_LINKS.map((link) => (
            <a
              key={link.id}
              href={link.href}
              className="hover:text-warm-800 transition-colors duration-300">
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
