import { ContentEditor } from "../../../components/admin/content-editor";
import { getDefaultSiteContent } from "../../../content/default-site-content";

/**
 * The CMS, at its own address (ESZ-155).
 *
 * `/admin` became the operational overview, so the editor needed a route of its
 * own. This is that route and nothing more: the same component, the same default
 * content, the same server draft, save, preview, publish, revision, conflict,
 * local-backup and import/export semantics it had at `/admin`. The editor's own
 * UX refactor is ESZ-156's, not this move's.
 */
export default function AdminContentPage() {
  return <ContentEditor defaultContent={getDefaultSiteContent()} />;
}
