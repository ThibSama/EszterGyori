import type { Metadata } from "next";
import { ReservationFlow } from "../components/reservation/reservation-flow";

export const metadata: Metadata = {
  title: "Réserver un rendez-vous | Eszter Gyori",
  description: "Choisissez une prestation, une date et un créneau disponible en heure de Paris.",
};

export default function ReservationPage() {
  return <ReservationFlow />;
}
