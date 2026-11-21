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

  // `X-Powered-By: Next.js` on every response, for the same reason the API
  // drops Express's: free reconnaissance, no benefit. Not a security control.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Every route, including the API proxy and the static assets.
        source: '/:path*',
        headers: [
          // ------------------------------------------------------------
          // CLICKJACKING
          // ------------------------------------------------------------
          //
          // Nothing here was stopping a third-party page from loading the
          // dashboard in an invisible iframe and sitting a decoy button over
          // "Approve". The session cookie is `SameSite=Lax`, which blocks it
          // on a cross-site POST but NOT on a framed top-level GET, and the
          // approve flow is a click behind a confirmation dialog - exactly
          // the shape this attack is built for.
          //
          // `frame-ancestors` is the modern control and the one browsers
          // honour; `X-Frame-Options` is sent alongside it for the handful
          // that still only read that. They agree, deliberately: the
          // application is never framed by anything, so the strictest value
          // costs nothing.
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },

          // The browser must not sniff a response into a type it was not
          // sent as - the one case that matters here is a user-supplied
          // string echoed back and guessed to be HTML.
          { key: 'X-Content-Type-Options', value: 'nosniff' },

          // Expense ids, review ids and company ids travel in paths. Without
          // this, a full URL carrying one is sent as the `Referer` to any
          // third-party origin a page ever reaches.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
