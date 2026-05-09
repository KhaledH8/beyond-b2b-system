import type { NextRequest } from 'next/server';
import { getAuth0Client } from './lib/auth0';

/**
 * Next.js 15 middleware (ADR-029 step 2).
 *
 * Mounts the Auth0 SDK's authentication routes:
 *
 *   /auth/login     — initiates Universal Login redirect
 *   /auth/logout    — clears session + redirects to Auth0 v2/logout
 *   /auth/callback  — receives Auth0 authorization code
 *
 * (Verified against `@auth0/nextjs-auth0` v4.20.0 — the SDK mounts
 * these routes on its own; no manual `app/api/auth/[...auth0]/route.ts`
 * is required, and the v3 `/api/auth/*` paths are NOT used.)
 *
 * The matcher excludes Next's static assets and metadata files. Every
 * other request passes through middleware so the SDK can roll the
 * session cookie's expiry on activity.
 *
 * Note for Next.js 16: this file should be renamed to `proxy.ts` and
 * the exported function renamed to `proxy`. ADR-029 step 2 ships on
 * Next 15; the rename is owed when the repo upgrades to Next 16.
 */
export async function middleware(request: NextRequest) {
  return await getAuth0Client().middleware(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
