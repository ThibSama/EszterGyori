import { SitePreview } from "./components/site-preview";
import { loadPublicSiteContent } from "./lib/server/public-content";

export const revalidate = 60;

export default async function Home() {
  const result = await loadPublicSiteContent();

  return <SitePreview content={result.content} />;
}
