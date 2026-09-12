import type { Metadata } from "next";
import { LegalNotice } from "../components/legal/legal-notice";

export const metadata: Metadata = {
  title: "Mentions légales | Eszter Gyori",
  description: "Identité de l’éditeur du site, immatriculation, contact et hébergement.",
};

/** `/mentions-legales` (ESZ-165): the legal notice, read from the stored legal document. */
export default function LegalNoticePage() {
  return <LegalNotice />;
}
