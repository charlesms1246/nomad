import Link from "next/link";
import { GITHUB_URL } from "./Nav";

export default function Footer() {
  return (
    <footer className="mx-auto w-full max-w-6xl px-5 pb-10 pt-20 sm:px-8">
      <div className="flex flex-col gap-8 border-t border-white/10 pt-10 md:flex-row md:items-end md:justify-between">
        <p className="font-pixel text-6xl leading-none text-[#f0efec] sm:text-7xl">
          NOMAD<span className="text-[var(--accent-color)]">.</span>
        </p>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[#c3c2b7]">
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-[#f0efec]">
            GitHub
          </a>
          <Link href="/v2" className="hover:text-[#f0efec]">
            Live rings
          </Link>
          <Link href="/dashboard" className="hover:text-[#f0efec]">
            Matcher dashboard
          </Link>
        </nav>
      </div>
      <p className="mt-6 text-sm text-[#898781]">Built at NEAR HACKATHON · testnet</p>
    </footer>
  );
}
