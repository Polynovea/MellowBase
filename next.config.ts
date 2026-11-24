import type { NextConfig } from "next";

// The server image (Dockerfile) builds with POLYNOVEA_STANDALONE=1 and runs `node server.js`. Every
// other build is unchanged, so `next start` (Playwright, certify-all, local runs) keeps working.
const standalone = process.env.POLYNOVEA_STANDALONE === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(standalone ? { output: "standalone" as const } : {}),
  serverExternalPackages: [
    "@supabase/supabase-js",
    "@aws-sdk/client-s3",
    "@google-analytics/data",
    "pg",
  ],
  async headers() {
    return [
      {
        source: "/api/content/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
        ],
      },
    ];
  },
};

export default nextConfig;
