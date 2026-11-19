import type { NextConfig } from 'next';

/**
 * Note: there is deliberately no `rewrites()` here.
 *
 * The same-origin API proxy lives in `app/api/[...path]/route.ts` instead,
 * because Next resolves `rewrites()` at build time and freezes the destination
 * into the routes manifest. The image is built without INTERNAL_API_URL, so a
 * rewrite baked `http://localhost:3001` and every proxied request failed at
 * runtime. See that file, and ADR-008, for the full reasoning.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
