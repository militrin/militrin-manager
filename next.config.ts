import type { NextConfig } from "next";

const confirmHeaders = [
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
  { key: "Pragma", value: "no-cache" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/auth/confirmar", headers: confirmHeaders },
      { source: "/auth/confirmar/:path*", headers: confirmHeaders },
      { source: "/auth/confirm", headers: confirmHeaders },
      { source: "/auth/confirm/:path*", headers: confirmHeaders },
    ];
  },
};

export default nextConfig;
