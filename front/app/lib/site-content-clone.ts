import type { SiteContent } from "../types/site-content";

/**
 * A deep copy of an editable document.
 *
 * Used at every boundary where content crosses between the server's copy and the
 * editor's: a loaded draft, a saved draft coming back normalised, a restored
 * backup. Sharing a reference across one of those is what produces the bug where
 * editing a field also mutates the "clean" copy it is being compared against, so
 * the dirty flag never turns on and a save is silently skipped.
 *
 * `structuredClone` rather than a JSON round trip: the content is plain data
 * today, but a JSON clone silently drops anything that is not, and it would do so
 * on the path where the loss is least visible.
 */
export function cloneSiteContent(content: SiteContent): SiteContent {
  return structuredClone(content);
}
