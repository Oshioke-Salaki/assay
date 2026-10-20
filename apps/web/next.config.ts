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
  // Paid calls from the browser go through the site's own origin, so they work on every domain the
  // site is served from without the API listing each one for CORS. Payment headers pass through.
  async rewrites() {
    return [{ source: "/x402/v1/:route(check|attest)/:address", destination: `${api}/v1/:route/:address` }];
  },
  env: { NEXT_PUBLIC_ASSAY_API: api },
};

export default config;
