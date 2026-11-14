import Link from "next/link";
import LogoMark from "@/components/LogoMark";

export const GITHUB_URL = "https://github.com/charlesms1246/nomad";

export default function Nav() {
  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/" className="font-pixel text-xl tracking-tight text-[#f0efec]" aria-label="Nomad home">
          <LogoMark className="mr-[0.2em] inline-block h-[1.1em] w-[1.1em] align-[-0.2em]" />
          NOMAD<span className="text-[var(--accent-color)]">.</span>
        </Link>
        <div className="flex items-center gap-4 text-sm text-[#c3c2b7] sm:gap-6">
          <Link href="/v2" className="hover:text-[#f0efec]">
            Live rings
          </Link>
          <Link href="/dashboard" className="hover:text-[#f0efec]">
            Dashboard
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-[#f0efec]">
            GitHub
          </a>
        </div>
      </nav>
    </header>
  );
}
