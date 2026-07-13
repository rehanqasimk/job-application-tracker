/**
 * Tenant Router Middleware (feature 001-tenant-router-middleware).
 *
 * Runs at the EDGE on every matched request. Responsibilities:
 *   1. Resolve the tenant from the request subdomain.
 *   2. Validate the session WITHOUT touching MongoDB or any Node-only module
 *      (the old getSession() call crashed the Edge Runtime via mongoose/bcrypt).
 *   3. Inject a trusted `x-tenant-id` header for downstream Server Actions.
 *
 * ⚠️ EDGE PURITY (constitution gate G1): the only imports allowed here are
 * `next/server` and the edge-pure `lib/tenant/*` helpers (which themselves only
 * touch `better-auth/cookies` + Web APIs). Never import `lib/auth/auth.ts`,
 * `lib/db`, `lib/models/*`, mongoose, or bcrypt — `next build` will fail the
 * edge compile if you do (that failure is the intended guardrail).
 *
 * Full behavior matrix: specs/001-tenant-router-middleware/contracts/tenant-routing.md
 */
import { NextRequest, NextResponse } from "next/server";
import { getSubdomain } from "./lib/tenant/subdomain";
import { getEdgeSession } from "./lib/tenant/session-edge";

const ROOT_DOMAIN = process.env.ROOT_DOMAIN ?? "lvh.me";
const TENANT_ID_HEADER = "x-tenant-id";
const TENANT_SUBDOMAIN_HEADER = "x-tenant-subdomain";

// Apex routes that an authenticated user should be bounced off of, onto their
// own tenant subdomain (dashboard). Includes "/" so a logged-in visitor landing
// on the apex root is taken straight to their workspace rather than the public
// marketing page. (Remove "/" here if you'd rather keep marketing reachable
// while logged in.)
const PROMOTE_PATHS = new Set(["/", "/dashboard", "/sign-in", "/sign-up"]);

export default async function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  const subdomain = getSubdomain(host, ROOT_DOMAIN);

  // ── Row 1/2: apex, www, or reserved label ────────────────────────────────
  // No tenant to route. Serve the public/marketing/sign-in area unchanged —
  // EXCEPT that an already-authenticated user must not sit on the apex auth/app
  // routes. The sign-in/sign-up pages push to `/dashboard` on the current host
  // (the apex), so this branch is what carries them across to their own
  // `<slug>.<root>` subdomain after login.
  if (!subdomain) {
    if (PROMOTE_PATHS.has(request.nextUrl.pathname)) {
      const session = await getEdgeSession(request);
      if (session?.subdomain) {
        return NextResponse.redirect(
          tenantUrl(request, session.subdomain, "/dashboard")
        );
      }
    }
    // Not authenticated (or a marketing route): serve unchanged, but strip any
    // inbound tenant headers so a client can't forge one (defense-in-depth).
    return stripTenantHeaders(request);
  }

  // Validate the session from the signed cookie cache — no DB, edge-safe.
  const session = await getEdgeSession(request);

  // ── Row 3: tenant subdomain but no valid session ─────────────────────────
  // Send the visitor to sign-in on the apex (FR-005).
  if (!session) {
    return NextResponse.redirect(signInUrl(request));
  }

  // ── Row 7: authenticated but no subdomain assigned (legacy/un-backfilled) ─
  // Can't place them on a tenant; send to apex onboarding fallback.
  if (!session.subdomain) {
    return NextResponse.redirect(apexUrl(request));
  }

  // ── Row 5: cross-tenant access — session tenant ≠ requested subdomain ─────
  // Redirect to the user's OWN subdomain; never serve the other tenant (FR-006).
  if (session.subdomain !== subdomain) {
    return NextResponse.redirect(tenantUrl(request, session.subdomain));
  }

  // A tenant's home is the app, not the public marketing landing (that lives on
  // the apex only). Send the tenant root to the dashboard.
  if (request.nextUrl.pathname === "/") {
    return NextResponse.redirect(
      tenantUrl(request, session.subdomain, "/dashboard")
    );
  }

  // ── Row 4: authorized — inject the trusted tenant headers (FR-001..004) ───
  // Clone incoming headers, then OVERWRITE the tenant headers from the verified
  // session so a client can never spoof `x-tenant-id` (contract C1 / gate G2).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(TENANT_ID_HEADER, session.userId);
  requestHeaders.set(TENANT_SUBDOMAIN_HEADER, session.subdomain);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

// ── URL helpers ─────────────────────────────────────────────────────────────
// Rebuild absolute URLs on the apex / a given tenant while preserving the dev
// port. `request.nextUrl` already carries protocol + port.

function apexHost(request: NextRequest): string {
  const port = request.nextUrl.port;
  return port ? `${ROOT_DOMAIN}:${port}` : ROOT_DOMAIN;
}

function apexUrl(request: NextRequest): URL {
  const url = request.nextUrl.clone();
  url.host = apexHost(request);
  url.pathname = "/";
  return url;
}

function signInUrl(request: NextRequest): URL {
  const url = apexUrl(request);
  url.pathname = "/sign-in";
  return url;
}

function tenantUrl(
  request: NextRequest,
  tenant: string,
  pathname?: string
): URL {
  const url = request.nextUrl.clone();
  const port = request.nextUrl.port;
  url.host = port
    ? `${tenant}.${ROOT_DOMAIN}:${port}`
    : `${tenant}.${ROOT_DOMAIN}`;
  // Default: preserve the current path (used by the cross-tenant redirect, row
  // 5). When a pathname is given, force it (apex→tenant promotion → dashboard).
  if (pathname) url.pathname = pathname;
  return url;
}

/** Forward the request but guarantee no inbound tenant headers survive. */
function stripTenantHeaders(request: NextRequest): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(TENANT_ID_HEADER);
  requestHeaders.delete(TENANT_SUBDOMAIN_HEADER);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// Skip Next internals, static assets, and the better-auth API routes (those must
// reach the Node runtime to sign in). Everything else flows through the router.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/auth|.*\\.[\\w]+$).*)",
  ],
};
