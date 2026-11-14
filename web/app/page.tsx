import Background from "@/components/landing/Background";
import Hero from "@/components/landing/Hero";
import Nav from "@/components/landing/Nav";

export default function Home() {
  return (
    <main className="relative min-h-screen w-full text-[#f0efec]">
      <Background />
      <div className="relative z-10">
        <Nav />
        <Hero />
        <section id="replay" className="mx-auto min-h-[60vh] max-w-6xl scroll-mt-6 px-5 sm:px-8" />
      </div>
    </main>
  );
}
