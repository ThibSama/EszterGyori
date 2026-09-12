import type { Metadata } from "next";
import { PrivacyPolicy } from "../components/legal/privacy-policy";

export const metadata: Metadata = {
  title: "Politique de confidentialité | Eszter Gyori",
  description:
    "Comment vos données de réservation sont utilisées, conservées et protégées, et comment exercer vos droits.",
};

/**
 * `/confidentialite` (ESZ-165): the privacy policy — the destination the
 * ESZ-161 booking notice froze, made real.
 */
export default function PrivacyPolicyPage() {
  return <PrivacyPolicy />;
}
