import type { Metadata } from "next";
import NomadDashboard from "@/components/dash/NomadDashboard";

export const metadata: Metadata = {
  title: "Nomad · matcher dashboard",
  description: "The agents at work, every ring event, the rings settled on testnet, agent balances and reputation, read from the matcher.",
};

// Query flag (read in the browser): ?mock=1 serves the UI fixture.
export default function DashboardPage() {
  return <NomadDashboard />;
}
