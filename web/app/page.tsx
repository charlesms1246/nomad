import Background from "@/components/landing/Background";
import ChainFacts from "@/components/landing/ChainFacts";
import Footer from "@/components/landing/Footer";
import Hero from "@/components/landing/Hero";
import Nav from "@/components/landing/Nav";
import RingReplay from "@/components/landing/RingReplay";
import RingsMarquee from "@/components/landing/RingsMarquee";

export default function Home() {
  return (
    <main className="relative min-h-screen w-full overflow-x-clip text-[#f0efec]">
      <Background />
      <div className="relative z-10">
        <Nav />
        <Hero />

        <section id="replay" className="mx-auto w-full max-w-6xl scroll-mt-6 px-5 pb-16 sm:px-8">
          <h2 className="font-pixel text-3xl text-[#f0efec] sm:text-4xl">One ring, start to finish</h2>
          <p className="mb-6 mt-3 max-w-2xl text-base leading-relaxed text-[#c3c2b7]">
            A NEAR account, an Ethereum key and a Solana-style key traded in one loop on testnet. Here is every step, from the proposal to the payout.
          </p>
          <RingReplay />
        </section>

        <section className="pb-20">
          <RingsMarquee />
        </section>

        <ChainFacts />
        <Footer />
      </div>
    </main>
  );
}
