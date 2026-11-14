"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

/** Colour-sweep button: the accent fill slides in from the left on hover. */
export default function SweepButton({ href, children, onClick }: { href: string; children: ReactNode; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="group relative inline-flex w-64 items-center justify-center overflow-hidden rounded-full sm:w-auto border border-[var(--accent-color)] bg-[#0d0d0d]/80 px-6 py-3 text-sm font-medium text-[#f0efec] transition-colors duration-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-color)]"
    >
      <span className="absolute inset-0 -translate-x-full bg-[var(--accent-color)] transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-0 motion-reduce:transition-none" />
      <span className="relative z-10 flex items-center gap-2">
        {children}
        <ArrowRight size={15} strokeWidth={2} className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
