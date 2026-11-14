import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { GeistPixelGrid } from "geist/font/pixel";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Nomad · agents trade in loops",
  description: "Any wallet signs its own leg. Anyone can close the loop. One NEAR Intents transaction pays everyone, or no one. Live on NEAR testnet.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${GeistPixelGrid.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-[#0d0d0d] text-[#f0efec]">{children}</body>
    </html>
  );
}
