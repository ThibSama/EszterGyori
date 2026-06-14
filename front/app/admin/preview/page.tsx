import type { Metadata } from "next";
import { getDefaultSiteContent } from "../../content/default-site-content";
import { requireAdminSession } from "../../lib/auth";
import { AdminPreviewClient } from "./admin-preview-client";

export const metadata: Metadata = {
  title: "Aperçu admin - Eszter",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AdminPreviewPage() {
  await requireAdminSession();

  return <AdminPreviewClient defaultContent={getDefaultSiteContent()} />;
}
