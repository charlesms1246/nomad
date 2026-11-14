import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  // The dev-only Next.js badge stays out of local screenshots (production never shows it).
  devIndicators: false,
  // Old links to /v2 keep working (the query string is passed through).
  async redirects() {
    return [{ source: "/v2", destination: "/rings", permanent: true }];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
