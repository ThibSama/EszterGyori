import type { Metadata } from "next";
import { getDefaultSiteContent } from "../../content/default-site-content";
import { requireAdminSession } from "../../lib/auth";
import { PRIVATE_ROBOTS } from "../../lib/metadata/site-metadata";
import { AdminPreviewClient } from "./admin-preview-client";

export const metadata: Metadata = {
  title: "Aperçu",
  robots: PRIVATE_ROBOTS,
};

export default async function AdminPreviewPage() {
  await requireAdminSession();

  return <AdminPreviewClient defaultContent={getDefaultSiteContent()} />;
}
