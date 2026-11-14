import type { Metadata } from "next";
import V2Rings from "@/components/V2Rings";

export const metadata: Metadata = {
  title: "Nomad v2 · open rings, any wallet",
  description: "Rings on rings.nomadswarm.testnet, read live from testnet: legs signed by NEAR, Ethereum and Solana-style wallets, closed by anyone.",
};

export default function V2Page() {
  return <V2Rings />;
}
