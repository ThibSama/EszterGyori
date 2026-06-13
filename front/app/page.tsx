import { SitePreview } from "./components/site-preview";
import { getDefaultSiteContent } from "./content/default-site-content";

export default function Home() {
  return <SitePreview content={getDefaultSiteContent()} />;
}
