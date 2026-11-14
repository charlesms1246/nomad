import type { Metadata } from "next";
import OnchainRings from "@/components/OnchainRings";

export const metadata: Metadata = {
  title: "Live rings · open rings, any wallet",
  description: "Rings on rings.nomadswarm.testnet, read live from testnet: legs signed by NEAR, Ethereum and Solana-style wallets, closed by anyone.",
};

export default function RingsPage() {
  return <OnchainRings />;
}
