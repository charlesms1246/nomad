import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";

export const metadata: Metadata = {
  title: "Nomad · matcher dashboard",
  description: "The v1 matcher dashboard: ring graph, rings table, swarm and race panels, with an on-chain re-check of every settlement.",
};

// Query flags (read in the browser): ?demo=1, ?captions=0, ?mock=1, ?verify=1.
export default function DashboardPage() {
  return <Dashboard />;
}
