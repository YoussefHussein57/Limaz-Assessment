/**
 * Same-origin API proxy (ADR-008, assumption A10).
 *
 * The browser only ever talks to the web origin. Every `/api/*` request lands
 * here and is forwarded server-side to the NestJS service over the Docker
 * network, so the session cookie stays first-party, `SameSite=Lax` keeps
 * working as CSRF protection, and no CORS configuration exists anywhere.
 *
 * WHY A ROUTE HANDLER AND NOT `rewrites()` IN next.config:
 *
 * Next resolves `rewrites()` at BUILD time and freezes the result into
 * .next/routes-manifest.json. The image is built without INTERNAL_API_URL -
 * correctly, since build time is not deployment time - so the destination was
 * baked as `http://localhost:3001`, which inside the web container means the
 * web container itself. Every proxied request returned 500. Caught by test
 * F00-T05.
 *
 * A route handler reads the environment per request, so one image works in
 * every environment. It is also the layer where cookie and header forwarding
 * will live from F02 onwards.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:3001';

/** Hop-by-hop and length headers that must not be copied onto a new request. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
]);

/** Headers describing the upstream framing, invalid once we re-stream. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const search = new URL(request.url).search;
  const target = `${INTERNAL_API_URL}/${path.join('/')}${search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  // A streamed body requires `duplex: 'half'` in Node's fetch. GET and HEAD
  // must not carry one at all.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    // The upstream address is never echoed: it is internal topology.
    return Response.json({ error: 'upstream_unavailable' }, { status: 502 });
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') {
      responseHeaders.set(key, value);
    }
  });

  // `headers.get('set-cookie')` collapses multiple cookies into one malformed
  // string. getSetCookie() preserves them individually, which matters as soon
  // as login starts issuing a session cookie (F02).
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
