import { ContentEditor } from "../components/admin/content-editor";
import { getDefaultSiteContent } from "../content/default-site-content";

export default function AdminPage() {
  return <ContentEditor defaultContent={getDefaultSiteContent()} />;
}
