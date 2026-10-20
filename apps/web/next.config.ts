import type { NextConfig } from "next";

const api = process.env.NEXT_PUBLIC_ASSAY_API ?? "http://localhost:8787";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@assay/core"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  env: { NEXT_PUBLIC_ASSAY_API: api },
};

export default config;
